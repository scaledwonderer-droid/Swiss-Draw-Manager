(() => {
  'use strict';

  const STORAGE_KEY = 'swiss-draw-manager-v1';
  const DATA_VERSION = 1;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  const defaultState = () => ({
    version: DATA_VERSION,
    settings: { name: '', totalRounds: 5, winPoints: 3, lossPoints: 0, byePoints: 3 },
    status: 'setup', tab: 'matches', currentRound: 0,
    players: [], rounds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });

  let state = defaultState();
  let toastTimer;

  function playerBase(player, index = 0) {
    return {
      id: player.id, name: player.name, active: player.active !== false, seed: player.seed ?? index,
      matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 0, matchPoints: 0,
      gameDiff: 0, opponentScore: 0, opponents: [], byeCount: 0, matches: [],
      wlwWins: 0, lwwWins: 0, twoZeroWins: 0, twoOneWins: 0
    };
  }

  function deriveStats(source = state) {
    const stats = new Map(source.players.map((p, i) => [p.id, playerBase(p, i)]));
    const rounds = Array.isArray(source.rounds) ? source.rounds : [];
    for (const round of rounds) {
      for (const match of round.pairings || []) {
        if (!match.confirmed) continue;
        if (match.isBye) {
          const p = stats.get(match.p1Id);
          if (p) { p.byeCount++; p.matchPoints += Number(source.settings.byePoints); p.matches.push({ round: round.number, bye: true }); }
          continue;
        }
        const a = stats.get(match.p1Id), b = stats.get(match.p2Id);
        if (!a || !b || !validFinishedGames(match.games)) continue;
        const aw = match.games.filter(id => id === a.id).length;
        const bw = match.games.length - aw;
        const winner = aw === 2 ? a : b, loser = aw === 2 ? b : a;
        a.gameWins += aw; a.gameLosses += bw; b.gameWins += bw; b.gameLosses += aw;
        winner.matchWins++; loser.matchLosses++;
        winner.matchPoints += Number(source.settings.winPoints); loser.matchPoints += Number(source.settings.lossPoints);
        a.opponents.push(b.id); b.opponents.push(a.id);
        const aSeq = match.games.map(id => id === a.id ? 'W' : 'L').join('-');
        const bSeq = match.games.map(id => id === b.id ? 'W' : 'L').join('-');
        if (winner.id === a.id) {
          if (aSeq === 'W-L-W') a.wlwWins++;
          if (aSeq === 'L-W-W') a.lwwWins++;
          aw === 2 && bw === 0 ? a.twoZeroWins++ : a.twoOneWins++;
        } else {
          if (bSeq === 'W-L-W') b.wlwWins++;
          if (bSeq === 'L-W-W') b.lwwWins++;
          bw === 2 && aw === 0 ? b.twoZeroWins++ : b.twoOneWins++;
        }
        a.matches.push({ round: round.number, opponentId: b.id, games: [...match.games], score: `${aw}-${bw}`, sequence: aSeq, won: aw === 2 });
        b.matches.push({ round: round.number, opponentId: a.id, games: [...match.games], score: `${bw}-${aw}`, sequence: bSeq, won: bw === 2 });
      }
    }
    for (const p of stats.values()) p.gameDiff = p.gameWins - p.gameLosses;
    for (const p of stats.values()) p.opponentScore = p.opponents.reduce((sum, id) => sum + (stats.get(id)?.matchPoints || 0), 0);
    return stats;
  }

  function standings(source = state) {
    const stats = [...deriveStats(source).values()];
    return stats.sort((a, b) =>
      b.matchPoints - a.matchPoints || b.gameDiff - a.gameDiff || b.opponentScore - a.opponentScore ||
      b.matchWins - a.matchWins || a.seed - b.seed || a.id.localeCompare(b.id)
    );
  }

  function validFinishedGames(games) {
    if (!Array.isArray(games) || games.length < 2 || games.length > 3) return false;
    const counts = new Map(); games.forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
    if (games.length === 2) return counts.size === 1;
    return games[0] !== games[1] && counts.size === 2 && [...counts.values()].sort().join(',') === '1,2';
  }

  function tendency(stats) {
    const decisiveWins = stats.twoOneWins + stats.twoZeroWins;
    return decisiveWins ? stats.wlwWins / decisiveWins : 0;
  }

  function matchCost(a, b) {
    const rematch = a.opponents.includes(b.id) ? 1 : 0;
    const pointGap = Math.abs(a.matchPoints - b.matchPoints);
    const tendencyGap = Math.abs(tendency(a) - tendency(b));
    const rankGap = Math.abs(a.rank - b.rank);
    return rematch * 500000 + pointGap * 100000 + tendencyGap * 1000 + rankGap;
  }

  function exactPairs(players) {
    const memo = new Map();
    const solve = (remaining) => {
      if (!remaining.length) return { cost: 0, pairs: [] };
      const key = remaining.map(p => p.id).join('|');
      if (memo.has(key)) return memo.get(key);
      const first = remaining[0]; let best = { cost: Infinity, pairs: [] };
      for (let i = 1; i < remaining.length; i++) {
        const other = remaining[i];
        const rest = remaining.slice(1, i).concat(remaining.slice(i + 1));
        const tail = solve(rest); const cost = matchCost(first, other) + tail.cost;
        if (cost < best.cost) best = { cost, pairs: [[first, other], ...tail.pairs] };
      }
      memo.set(key, best); return best;
    };
    return solve(players).pairs;
  }

  function beamPairs(players, width = 240) {
    let beams = [{ left: players, pairs: [], cost: 0 }];
    while (beams[0]?.left.length) {
      const next = [];
      for (const node of beams) {
        const [first, ...rest] = node.left;
        const candidates = rest.map((p, i) => ({ p, i, cost: matchCost(first, p) })).sort((a, b) => a.cost - b.cost).slice(0, 10);
        for (const c of candidates) next.push({
          left: rest.slice(0, c.i).concat(rest.slice(c.i + 1)),
          pairs: [...node.pairs, [first, c.p]], cost: node.cost + c.cost
        });
      }
      beams = next.sort((a, b) => a.cost - b.cost).slice(0, width);
    }
    return beams[0]?.pairs || [];
  }

  function chooseBye(activeStats) {
    return [...activeStats].sort((a, b) => a.byeCount - b.byeCount || a.matchPoints - b.matchPoints || a.gameDiff - b.gameDiff || b.rank - a.rank)[0];
  }

  function generatePairing(source = state) {
    const ranked = standings(source).map((p, i) => ({ ...p, rank: i + 1 })).filter(p => p.active);
    let bye = null;
    if (ranked.length % 2) { bye = chooseBye(ranked); ranked.splice(ranked.findIndex(p => p.id === bye.id), 1); }
    const pairs = ranked.length <= 18 ? exactPairs(ranked) : beamPairs(ranked);
    return { pairs: pairs.map(([a, b]) => ({ p1Id: a.id, p2Id: b.id, rematch: a.opponents.includes(b.id) })), bye };
  }

  function createRound() {
    const roundNumber = state.rounds.length + 1;
    const generated = generatePairing(state);
    const pairings = generated.pairs.map((p, i) => ({ id: uid('match'), table: i + 1, ...p, isBye: false, games: [], confirmed: false }));
    if (generated.bye) pairings.push({ id: uid('bye'), table: null, p1Id: generated.bye.id, p2Id: null, isBye: true, games: [], confirmed: true, rematch: false });
    state.rounds.push({ number: roundNumber, status: 'open', pairings });
    state.currentRound = roundNumber; state.tab = 'matches';
    save(); render();
  }

  function save() {
    state.updatedAt = new Date().toISOString();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { toast('自動保存できませんでした'); }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (validateImport(parsed).ok) state = parsed;
    } catch (_) { /* start clean */ }
  }

  function validateImport(data) {
    if (!data || typeof data !== 'object') return { ok: false, message: 'JSONの内容が正しくありません。' };
    if (data.version !== DATA_VERSION || !['setup','active','finished'].includes(data.status)) return { ok: false, message: '対応していないデータ形式です。' };
    if (!data.settings || !Array.isArray(data.players) || !Array.isArray(data.rounds)) return { ok: false, message: '必要な大会データが不足しています。' };
    const totalRounds = Number(data.settings.totalRounds);
    const pointValues = [data.settings.winPoints, data.settings.lossPoints, data.settings.byePoints].map(Number);
    if (!Number.isInteger(totalRounds) || totalRounds < 1 || totalRounds > 30 || pointValues.some(n => !Number.isFinite(n) || n < 0 || n > 99)) return { ok: false, message: '大会設定の数値が正しくありません。' };
    if (!Number.isInteger(data.currentRound) || data.currentRound < 0 || data.currentRound > totalRounds) return { ok: false, message: '現在ラウンドの値が正しくありません。' };
    const ids = new Set();
    for (const p of data.players) {
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !p.name.trim() || ids.has(p.id)) return { ok: false, message: 'プレイヤーデータが正しくありません。' };
      ids.add(p.id);
    }
    const roundNumbers = new Set(), matchIds = new Set();
    for (const r of data.rounds) {
      if (!r || !Number.isInteger(r.number) || r.number < 1 || r.number > totalRounds || roundNumbers.has(r.number) || !['open','complete'].includes(r.status) || !Array.isArray(r.pairings)) return { ok: false, message: 'ラウンドデータが正しくありません。' };
      roundNumbers.add(r.number);
      for (const m of r.pairings) {
        if (!m || typeof m.id !== 'string' || matchIds.has(m.id) || !ids.has(m.p1Id) || (!m.isBye && (!ids.has(m.p2Id) || m.p1Id === m.p2Id)) || !Array.isArray(m.games) || m.games.length > 3) return { ok: false, message: '対戦データが正しくありません。' };
        matchIds.add(m.id);
        if (!m.isBye && m.games.some(id => id !== m.p1Id && id !== m.p2Id)) return { ok: false, message: '対戦結果に不明なプレイヤーが含まれています。' };
        if (!m.isBye && m.games.length === 3 && m.games[0] === m.games[1]) return { ok: false, message: '2勝後に第3ゲームが記録されています。' };
        if (m.confirmed && !m.isBye && !validFinishedGames(m.games)) return { ok: false, message: '確定済み対戦のBO3結果が正しくありません。' };
      }
    }
    return { ok: true };
  }

  function toast(message) {
    const el = $('#toast'); if (!el) return;
    el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function nameOf(id) { return state.players.find(p => p.id === id)?.name || '不明'; }
  function currentRound() { return state.rounds.find(r => r.number === state.currentRound); }
  function scoreFor(match) {
    const a = match.games.filter(id => id === match.p1Id).length;
    return { a, b: match.games.length - a, aSeq: match.games.map(id => id === match.p1Id ? 'W' : 'L').join('-') || '—' };
  }

  function render() {
    const app = $('#app'); if (!app) return;
    const setup = state.status === 'setup';
    $('#bottom-nav').hidden = setup; $('#round-badge').hidden = setup;
    $('#header-title').textContent = setup ? 'Swiss Draw Manager' : state.settings.name;
    if (!setup) {
      $('#round-badge').textContent = state.status === 'finished' ? '大会終了' : `Round ${state.currentRound} / ${state.settings.totalRounds}`;
      $$('#bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
    }
    app.innerHTML = setup ? setupView() : tournamentView();
  }

  function setupView() {
    return `<div class="setup-grid">
      <section class="panel"><h2>大会を準備</h2><p class="lead">名前と参加者を登録すると、最初の組み合わせを自動で作成します。</p>
        <div class="field"><label for="tournament-name">大会名</label><input id="tournament-name" maxlength="80" value="${esc(state.settings.name)}" placeholder="例：土曜BO3対戦会"></div>
        <div class="field"><span class="field-label">参加プレイヤー</span><form id="add-player-form" class="inline-form"><input id="new-player" maxlength="40" placeholder="プレイヤー名" autocomplete="off"><button class="btn" type="submit">追加</button></form></div>
        <div class="player-list">${state.players.length ? state.players.map((p,i) => `<div class="setup-player"><span class="seed">${i+1}</span><span>${esc(p.name)}</span><button class="btn btn-ghost btn-small" data-remove-player="${p.id}">削除</button></div>`).join('') : '<div class="empty">2名以上のプレイヤーを追加してください</div>'}</div>
      </section>
      <section class="panel"><h2>大会設定</h2><p class="lead">ポイントは大会中も表示できますが、開始後は変更できません。</p>
        <div class="field"><label for="total-rounds">総ラウンド数</label><input id="total-rounds" type="number" min="1" max="30" value="${state.settings.totalRounds}"></div>
        <div class="settings-row">
          <div class="field"><label for="win-points">勝利</label><input id="win-points" type="number" min="0" max="99" value="${state.settings.winPoints}"></div>
          <div class="field"><label for="loss-points">敗北</label><input id="loss-points" type="number" min="0" max="99" value="${state.settings.lossPoints}"></div>
          <div class="field"><label for="bye-points">BYE</label><input id="bye-points" type="number" min="0" max="99" value="${state.settings.byePoints}"></div>
        </div>
        <button id="start-tournament" class="btn btn-block" ${state.players.length < 2 ? 'disabled' : ''}>大会開始</button>
        <p class="footer-note">データはこのブラウザに自動保存されます。別端末へ移す場合はJSONバックアップを利用できます。</p>
      </section>
    </div>`;
  }

  function tournamentView() {
    if (state.tab === 'standings') return standingsView();
    if (state.tab === 'players') return playersView();
    if (state.tab === 'history') return historyView();
    if (state.tab === 'settings') return settingsView();
    return matchesView();
  }

  function matchesView() {
    const round = currentRound();
    if (!round) return '<section class="panel"><div class="empty">ラウンドがありません</div></section>';
    const done = round.pairings.every(m => m.confirmed);
    const rematches = round.pairings.filter(m => m.rematch).length;
    return `<section class="section-head"><div><h2>Round ${round.number} 対戦</h2><p class="muted">各ゲームの勝者を順番に入力してください。</p></div><div class="section-actions">
      ${round.status === 'open' ? `<button id="finalize-round" class="btn" ${done ? '' : 'disabled'}>ラウンド確定</button>` : ''}
      ${round.status === 'complete' && state.status !== 'finished' ? '<button id="next-round" class="btn">次ラウンド生成</button>' : ''}
    </div></section>
    ${rematches ? `<div class="notice">組み合わせ上、${rematches}件の再戦を避けられませんでした。</div>` : ''}
    ${state.status === 'finished' ? '<div class="notice">全ラウンドが終了しました。順位タブで最終結果を確認できます。</div>' : ''}
    <div class="match-list">${round.pairings.map(matchCard).join('')}</div>`;
  }

  function matchCard(match) {
    if (match.isBye) return `<article class="match-card complete"><div class="match-top"><span class="table-number">BYE</span><span class="status-pill ok">自動確定</span></div><div class="versus"><strong>${esc(nameOf(match.p1Id))}</strong><span class="vs">—</span><strong>不戦</strong></div><div class="score-preview"><span class="sequence">${state.settings.byePoints}ポイント付与</span></div></article>`;
    const score = scoreFor(match), finished = validFinishedGames(match.games);
    const disabled = match.confirmed || currentRound()?.status === 'complete';
    return `<article class="match-card ${match.confirmed ? 'complete' : ''}" data-match-card="${match.id}">
      <div class="match-top"><span class="table-number">TABLE ${match.table}</span><span class="status-pill ${match.confirmed ? 'ok' : match.rematch ? 'warn' : ''}">${match.confirmed ? '確定済み' : match.rematch ? '再戦' : '入力中'}</span></div>
      <div class="versus"><strong>${esc(nameOf(match.p1Id))}</strong><span class="vs">VS</span><strong>${esc(nameOf(match.p2Id))}</strong></div>
      <div class="score-preview"><span class="score">${score.a} - ${score.b}</span><span class="sequence">${score.aSeq}</span></div>
      <div class="games">${[0,1,2].map(i => `<div class="game-row"><span class="game-label">Game ${i+1}</span>
        <button class="win-choice ${match.games[i] === match.p1Id ? 'selected' : ''}" data-game-winner="${match.p1Id}" data-match="${match.id}" data-game="${i}" ${disabled || i > match.games.length || (i === 2 && match.games.length < 2) ? 'disabled' : ''}>${esc(nameOf(match.p1Id))}</button>
        <button class="win-choice ${match.games[i] === match.p2Id ? 'selected' : ''}" data-game-winner="${match.p2Id}" data-match="${match.id}" data-game="${i}" ${disabled || i > match.games.length || (i === 2 && match.games.length < 2) ? 'disabled' : ''}>${esc(nameOf(match.p2Id))}</button></div>`).join('')}</div>
      <div class="card-actions">${match.confirmed ? `<button class="btn btn-secondary btn-small" data-edit-match="${match.id}">結果を修正</button>` : `<button class="btn btn-ghost btn-small" data-undo-game="${match.id}" ${match.games.length ? '' : 'disabled'}>1手戻す</button><button class="btn btn-small" data-confirm-match="${match.id}" ${finished ? '' : 'disabled'}>この結果で確定</button>`}</div>
    </article>`;
  }

  function standingsView() {
    const list = standings();
    return `<section class="section-head"><div><h2>${state.status === 'finished' ? '最終順位' : '順位'}</h2><p class="muted">対戦相手成績は、対戦した相手のマッチポイント合計です。</p></div></section>
      <div class="table-wrap"><table><thead><tr><th>順位</th><th>プレイヤー</th><th>マッチ</th><th>ポイント</th><th>ゲーム</th><th>ゲーム差</th><th>対戦相手成績</th><th>状態</th></tr></thead><tbody>
      ${list.map((p,i) => `<tr><td class="rank">${i+1}</td><td><button class="player-link" data-player-detail="${p.id}">${esc(p.name)}</button></td><td>${p.matchWins}勝 ${p.matchLosses}敗</td><td><strong>${p.matchPoints}</strong></td><td>${p.gameWins}勝 ${p.gameLosses}敗</td><td>${p.gameDiff > 0 ? '+' : ''}${p.gameDiff}</td><td>${p.opponentScore}</td><td>${p.active ? '参加中' : '<span class="drop-text">ドロップ</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function playersView() {
    const stats = deriveStats();
    return `<section class="section-head"><div><h2>プレイヤー</h2><p class="muted">名前の変更と、次ラウンド以降の参加状態を管理します。</p></div></section><div class="player-manage">
      ${state.players.map(p => { const s=stats.get(p.id); return `<div class="player-row"><div><input class="name-input" data-rename-player="${p.id}" maxlength="40" value="${esc(p.name)}"><div class="player-meta">${s.matchWins}勝 ${s.matchLosses}敗・${s.matchPoints}pt・BYE ${s.byeCount}回</div></div><button class="btn ${p.active ? 'btn-danger' : 'btn-secondary'} btn-small" data-toggle-drop="${p.id}">${p.active ? 'ドロップ' : '参加へ戻す'}</button></div>`; }).join('')}</div>`;
  }

  function historyView() {
    return `<section class="section-head"><div><h2>対戦履歴</h2><p class="muted">確定済み結果はここから修正できます。</p></div></section>
      ${[...state.rounds].reverse().map(r => `<section class="history-round"><h3>Round ${r.number} <span class="status-pill ${r.status==='complete'?'ok':''}">${r.status==='complete'?'確定':'進行中'}</span></h3><div class="history-grid">${r.pairings.map(m => {
        if(m.isBye) return `<div class="history-item"><div class="history-line"><strong>${esc(nameOf(m.p1Id))}</strong><span class="history-result">BYE</span></div></div>`;
        const s=scoreFor(m); return `<div class="history-item"><div class="history-line"><strong>${esc(nameOf(m.p1Id))} vs ${esc(nameOf(m.p2Id))}</strong><span class="history-result">${m.confirmed?`${s.a}-${s.b} ${s.aSeq}`:'未確定'}</span></div>${m.confirmed?`<button class="btn btn-ghost btn-small" data-edit-match="${m.id}">結果を修正</button>`:''}</div>`;
      }).join('')}</div></section>`).join('')}`;
  }

  function settingsView() {
    return `<section class="panel"><h2>大会データ</h2><p class="lead">この端末では自動保存されています。JSONは別端末への移行や予備保存に使えます。</p>
      <div class="section-actions" style="justify-content:flex-start"><button id="export-json" class="btn">JSONをエクスポート</button><button id="import-json" class="btn btn-secondary">JSONをインポート</button></div>
      <p class="footer-note">勝利 ${state.settings.winPoints}pt ／ 敗北 ${state.settings.lossPoints}pt ／ BYE ${state.settings.byePoints}pt ／ 全${state.settings.totalRounds}ラウンド</p>
      <div class="danger-zone"><h3>大会リセット</h3><p class="muted">現在の大会データをこのブラウザから削除し、初期画面へ戻します。</p><button id="reset-tournament" class="btn btn-danger">大会をリセット</button></div>
    </section>`;
  }

  function openModal(html) { $('#modal-content').innerHTML = html; $('#modal').showModal(); }
  function closeModal() { $('#modal').close(); }
  function modalShell(title, body, actions = '') { return `<div class="modal-body"><div class="modal-head"><div><h2>${esc(title)}</h2></div><button class="icon-btn" data-close-modal aria-label="閉じる">×</button></div>${body}${actions ? `<div class="modal-actions">${actions}</div>` : ''}</div>`; }

  function showPlayerDetail(id) {
    const s = deriveStats().get(id); if (!s) return;
    const body = `<div class="details-grid"><div class="stat-card"><div class="stat-label">マッチ</div><div class="stat-value">${s.matchWins}-${s.matchLosses}</div></div><div class="stat-card"><div class="stat-label">ゲーム</div><div class="stat-value">${s.gameWins}-${s.gameLosses}</div></div><div class="stat-card"><div class="stat-label">ポイント</div><div class="stat-value">${s.matchPoints}</div></div><div class="stat-card"><div class="stat-label">2-0勝利</div><div class="stat-value">${s.twoZeroWins}</div></div><div class="stat-card"><div class="stat-label">2-1勝利</div><div class="stat-value">${s.twoOneWins}</div></div><div class="stat-card"><div class="stat-label">W-L-W勝利</div><div class="stat-value">${s.wlwWins}</div></div><div class="stat-card"><div class="stat-label">L-W-W勝利</div><div class="stat-value">${s.lwwWins}</div></div></div><h3 style="margin-top:1.2rem">対戦履歴</h3><div class="detail-history">${s.matches.length ? s.matches.map(m => m.bye ? `<div><span>Round ${m.round}</span><strong>BYE</strong></div>` : `<div><span>Round ${m.round}　${esc(nameOf(m.opponentId))}</span><strong>${m.score}　${m.sequence}</strong></div>`).join('') : '<p class="muted">対戦履歴はありません。</p>'}</div>`;
    openModal(modalShell(s.name, body));
  }

  function findMatch(id) {
    for (const round of state.rounds) { const match = round.pairings.find(m => m.id === id); if (match) return { round, match }; }
    return null;
  }

  function editMatch(id) {
    const found = findMatch(id); if (!found || found.match.isBye) return;
    const { round, match } = found;
    const laterExists = state.rounds.some(r => r.number > round.number);
    const temp = [...match.games];
    const draw = () => {
      const fake = {...match,games:temp}; const s=scoreFor(fake);
      const body = `${laterExists ? '<div class="notice notice-danger">過去の結果を変更すると現在のペアリングと整合しなくなる可能性があります。</div>' : ''}
        <div class="versus"><strong>${esc(nameOf(match.p1Id))}</strong><span class="vs">VS</span><strong>${esc(nameOf(match.p2Id))}</strong></div><div class="score-preview"><span class="score">${s.a} - ${s.b}</span><span class="sequence">${s.aSeq}</span></div>
        <div class="games">${[0,1,2].map((i) => `<div class="game-row"><span class="game-label">Game ${i+1}</span><button class="win-choice ${temp[i]===match.p1Id?'selected':''}" data-edit-winner="${match.p1Id}" data-edit-game="${i}" ${i>temp.length || (i===2&&temp.length<2)?'disabled':''}>${esc(nameOf(match.p1Id))}</button><button class="win-choice ${temp[i]===match.p2Id?'selected':''}" data-edit-winner="${match.p2Id}" data-edit-game="${i}" ${i>temp.length || (i===2&&temp.length<2)?'disabled':''}>${esc(nameOf(match.p2Id))}</button></div>`).join('')}</div>`;
      openModal(modalShell('結果を修正', body, `<button class="btn btn-ghost" id="edit-undo" ${temp.length?'':'disabled'}>1手戻す</button><button class="btn" id="save-edit" ${validFinishedGames(temp)?'':'disabled'}>変更を保存</button>`));
      $$('[data-edit-winner]').forEach(btn => btn.onclick = () => { const i=Number(btn.dataset.editGame); temp.splice(i); temp[i]=btn.dataset.editWinner; closeModal(); draw(); });
      $('#edit-undo').onclick = () => { temp.pop(); closeModal(); draw(); };
      $('#save-edit').onclick = () => { if(!validFinishedGames(temp) || !confirm('この内容で対戦結果を変更しますか？\n成績と順位は自動で再計算されます。')) return; match.games=[...temp]; match.confirmed=true; save(); closeModal(); render(); toast('結果と順位を再計算しました'); };
      $('[data-close-modal]').onclick = closeModal;
    };
    draw();
  }

  function addGameWinner(matchId, winnerId, gameIndex) {
    const found = findMatch(matchId); if (!found || found.match.confirmed || validFinishedGames(found.match.games)) return;
    const games = found.match.games;
    if (gameIndex > games.length) return;
    games.splice(gameIndex); games[gameIndex] = winnerId;
    save(); render();
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    const safe = (state.settings.name || 'swiss-draw').replace(/[\\/:*?"<>|]/g,'_'); a.download = `${safe}-backup.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast('JSONを保存しました');
  }

  if (typeof document !== 'undefined') {
  document.addEventListener('submit', e => {
    if (e.target.id !== 'add-player-form') return; e.preventDefault();
    const input = $('#new-player'), name = input.value.trim(); if (!name) return;
    state.players.push({id:uid('player'),name,active:true,seed:state.players.length}); input.value=''; save(); render(); $('#new-player')?.focus();
  });

  document.addEventListener('change', e => {
    if (state.status === 'setup') {
      const map = {'tournament-name':'name','total-rounds':'totalRounds','win-points':'winPoints','loss-points':'lossPoints','bye-points':'byePoints'};
      if (map[e.target.id]) { const key=map[e.target.id]; state.settings[key]=key==='name'?e.target.value:String(e.target.value)===''?0:Number(e.target.value); save(); }
    }
    if (e.target.matches('[data-rename-player]')) {
      const p=state.players.find(x=>x.id===e.target.dataset.renamePlayer), name=e.target.value.trim();
      if (!name) { e.target.value=p.name; toast('名前は空にできません'); return; } p.name=name; save(); render();
    }
    if (e.target.id === 'import-file' && e.target.files[0]) {
      const file=e.target.files[0], reader=new FileReader();
      reader.onload=()=>{ try { const parsed=JSON.parse(reader.result); const check=validateImport(parsed); if(!check.ok) throw new Error(check.message); if(!confirm('現在の大会データを読み込んだデータで置き換えますか？')) return; state=parsed; save(); render(); toast('大会データを復元しました'); } catch(err) { alert(err.message||'JSONを読み込めませんでした。'); } finally { e.target.value=''; } };
      reader.readAsText(file);
    }
  });

  document.addEventListener('click', e => {
    const tab=e.target.closest('[data-tab]'); if(tab){state.tab=tab.dataset.tab;save();render();return;}
    const remove=e.target.closest('[data-remove-player]'); if(remove){state.players=state.players.filter(p=>p.id!==remove.dataset.removePlayer);state.players.forEach((p,i)=>p.seed=i);save();render();return;}
    if(e.target.closest('#start-tournament')){
      const name=$('#tournament-name').value.trim(); if(!name){alert('大会名を入力してください。');return;} if(state.players.length<2)return;
      state.settings.name=name; state.settings.totalRounds=Math.max(1,Math.min(30,Number($('#total-rounds').value)||1)); state.status='active'; createRound(); return;
    }
    const game=e.target.closest('[data-game-winner]'); if(game){addGameWinner(game.dataset.match,game.dataset.gameWinner,Number(game.dataset.game));return;}
    const undo=e.target.closest('[data-undo-game]'); if(undo){const f=findMatch(undo.dataset.undoGame);f?.match.games.pop();save();render();return;}
    const confirmMatch=e.target.closest('[data-confirm-match]'); if(confirmMatch){const f=findMatch(confirmMatch.dataset.confirmMatch);if(f&&validFinishedGames(f.match.games)){f.match.confirmed=true;save();render();toast('対戦結果を確定しました');}return;}
    if(e.target.closest('#finalize-round')){const r=currentRound();if(r&&!r.pairings.every(m=>m.confirmed))return;if(!confirm(`Round ${r.number}を確定しますか？`))return;r.status='complete';if(r.number>=Number(state.settings.totalRounds))state.status='finished';save();render();return;}
    if(e.target.closest('#next-round')){if(state.status!=='active'||currentRound()?.status!=='complete')return;createRound();return;}
    const edit=e.target.closest('[data-edit-match]');if(edit){editMatch(edit.dataset.editMatch);return;}
    const detail=e.target.closest('[data-player-detail]');if(detail){showPlayerDetail(detail.dataset.playerDetail);return;}
    const toggle=e.target.closest('[data-toggle-drop]');if(toggle){const p=state.players.find(x=>x.id===toggle.dataset.toggleDrop);if(!p)return;if(p.active&&!confirm(`${p.name}をドロップしますか？\n過去の戦績は保持され、次ラウンドから除外されます。`))return;p.active=!p.active;save();render();return;}
    if(e.target.closest('#export-json')){exportJson();return;}
    if(e.target.closest('#import-json')){$('#import-file').click();return;}
    if(e.target.closest('#reset-tournament')){if(!confirm('大会をリセットします。保存中のデータは失われます。\n先にJSONを保存しておくことをおすすめします。'))return;localStorage.removeItem(STORAGE_KEY);state=defaultState();render();return;}
    if(e.target.closest('[data-close-modal]')){closeModal();return;}
  });
  }

  if (typeof window !== 'undefined') window.SwissDrawTest = { defaultState, deriveStats, standings, validFinishedGames, generatePairing, validateImport, matchCost };
  if (typeof module !== 'undefined' && module.exports) module.exports = { defaultState, deriveStats, standings, validFinishedGames, generatePairing, validateImport, matchCost };
  if (typeof document !== 'undefined') { load(); render(); }
})();
