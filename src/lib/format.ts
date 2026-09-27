/**
 * 展示层纯函数：结算原因文案、判奖文案、战绩排序、结束方式文案与累计统计。
 *
 * 与规则有关的判断全部来自 shared/rules.ts 与 shared/rulesets.ts，不在这里复制第二份规则。
 */

import { NORMAL_PRIZE_KEYS, PRIZE_META, PRIZE_KEYS, resultRow } from '../../shared/rules.js';
import type {
  ChampionEvent,
  DiceResult,
  EndCondition,
  FinishedReason,
  Player,
  PrizeConfig,
  PrizeKey,
  RoomState,
  RollRecord,
} from '../../shared/types.js';

export const FINISHED_REASON_LABELS: Readonly<Record<FinishedReason, string>> = {
  'round-limit': '达到轮数上限',
  'pool-empty': '普通奖全部领完，完成本轮后结算',
  'host-ended': '房主提前结束',
  'players-left': '在座玩家不足2人',
  'offline-expired': '离线过期、未完成',
  'all-left': '全员离席、未完成',
};

export function finishedReasonLabel(reason: FinishedReason | null): string {
  return reason ? FINISHED_REASON_LABELS[reason] : '本局已结束';
}

export function endConditionLabel(value: EndCondition): string {
  return value.mode === 'all-prizes'
    ? '奖品发完结束'
    : '每人 ' + value.maxRounds + ' 轮';
}

export function turnRoundLabel(room: RoomState): string {
  const round = Math.max(1, room.round);
  if (room.config.endCondition.mode === 'rounds') {
    return `第 ${round}/${room.config.endCondition.maxRounds} 轮`;
  }
  return `第 ${round} 轮`;
}

export function totalNormalAwards(awards: Readonly<Record<PrizeKey, number>>): number {
  return NORMAL_PRIZE_KEYS.reduce((sum, key) => sum + awards[key], 0);
}

export function totalAwards(awards: Readonly<Record<PrizeKey, number>>): number {
  return PRIZE_KEYS.reduce((sum, key) => sum + awards[key], 0);
}

/**
 * 玩家已获实际份数：对局未结束时，未结算状元绝不计入已获份数；
 * 仅在 finished 终局结算后才包含实际发放的状元份数。
 */
export function settledAwardCountOf(player: Player | null | undefined, room: RoomState): number {
  if (!player) return 0;
  if (room.status === 'finished') {
    return totalAwards(player.awards);
  }
  return totalNormalAwards(player.awards);
}

export function totalConfiguredPrizes(prizes: PrizeConfig): number {
  return PRIZE_KEYS.reduce((sum, key) => sum + (prizes[key]?.count ?? 0), 0);
}

export function totalInitialPool(room: RoomState): number {
  return PRIZE_KEYS.reduce((sum, key) => sum + (room.initialPool?.[key] ?? room.config.prizes[key]?.count ?? 0), 0);
}

export function totalInitialNormalPool(room: RoomState): number {
  return NORMAL_PRIZE_KEYS.reduce((sum, key) => sum + (room.initialPool?.[key] ?? room.config.prizes[key]?.count ?? 0), 0);
}

/**
 * 战绩排序（rules-research 4.2）：状元拥有者优先，其次普通奖总数降序，最后入座顺序升序。
 * 只影响展示，不产生积分。离席得主仍保留在本局记录中，不过滤。
 */
export function standings(players: readonly Player[]): Player[] {
  return [...players].sort((a, b) => {
    const championA = a.awards.zhuangyuan > 0 ? 1 : 0;
    const championB = b.awards.zhuangyuan > 0 ? 1 : 0;
    if (championA !== championB) return championB - championA;
    const normalA = totalNormalAwards(a.awards);
    const normalB = totalNormalAwards(b.awards);
    if (normalA !== normalB) return normalB - normalA;
    return a.seat - b.seat;
  });
}

export function rollCountOf(history: readonly RollRecord[], playerId: string): number {
  return history.filter((record) => record.playerId === playerId && record.reason === 'rolled').length;
}

export function timeoutCountOf(history: readonly RollRecord[], playerId: string): number {
  return history.filter((record) => record.playerId === playerId && record.reason === 'timeout').length;
}

/** 读取玩家本局累计投掷次数（优先服务端累计字段，不受 240 条历史窗口裁剪影响）。 */
export function playerRollCount(player: Player, history: readonly RollRecord[] = []): number {
  return typeof player.rollCount === 'number' ? player.rollCount : rollCountOf(history, player.id);
}

/** 读取玩家本局累计超时跳过次数（优先服务端累计字段，不受 240 条历史窗口裁剪影响）。 */
export function playerTimeoutCount(player: Player, history: readonly RollRecord[] = []): number {
  return typeof player.timeoutCount === 'number' ? player.timeoutCount : timeoutCountOf(history, player.id);
}

/** 全桌本局累计实际投掷总数（来自各玩家 rollCount 之和）。 */
export function totalRoomRolls(room: RoomState): number {
  return room.players.reduce((sum, player) => sum + playerRollCount(player, room.history), 0);
}

/** 全桌本局累计超时跳过总数（来自各玩家 timeoutCount 之和）。 */
export function totalRoomTimeouts(room: RoomState): number {
  return room.players.reduce((sum, player) => sum + playerTimeoutCount(player, room.history), 0);
}

export interface RollHeadline {
  /** 主标题，例如“博得三红 · 获得1份”。 */
  title: string;
  /** 补充说明，例如“奖品已领完”或“好彩头留在下一掷”。 */
  detail: string | null;
  tone: 'champion' | 'prize' | 'empty' | 'none';
}

/**
 * 把一条投掷记录翻译成设计规范中的中文文案（同一份文案用于碗下方与记录列表）。
 *
 * 核心规则：
 * - 状元牌型严格按 `record.championOutcome` 描述当次投掷时的权威事实，绝不用后来变化的 `room.champion` 倒推解释旧记录；
 * - 普通奖展示配置的 `config.prizes[key].content` 与实际获得的份数。
 */
export function describeRoll(record: RollRecord, room?: RoomState | null): RollHeadline {
  if (record.reason === 'timeout' || record.result === null) {
    return { title: '本轮超时，已跳过', detail: '超时不掷骰、不发奖，消耗一次机会', tone: 'empty' };
  }
  const result = record.result;
  if (result.prize === 'zhuangyuan') {
    const outcome = record.championOutcome;
    const matchedEvent = room?.championEvents?.find((item) => item.recordId === record.id) ?? null;
    const fallbackNickname =
      room && outcome?.previousPlayerId
        ? (playerById(room, outcome.previousPlayerId)?.nickname ?? null)
        : null;
    const prevNickname = matchedEvent?.previousNickname ?? fallbackNickname;

    if (outcome) {
      switch (outcome.kind) {
        case 'first':
          return {
            title: `博得${result.label} · 首次登顶状元${outcome.locked ? '（已锁定）' : ''}`,
            detail: outcome.locked
              ? '高阶牌型锁定状元得主，本局继续至结束时发放状元奖'
              : '成为当前状元，结算时确定奖品归属',
            tone: 'champion',
          };
        case 'takeover':
          return {
            title: `博得${result.label} · 顶替${prevNickname ?? '前任'}成为当前状元${outcome.locked ? '（已锁定）' : ''}`,
            detail: outcome.locked
              ? '高阶牌型锁定状元得主，本局继续至结束时发放状元奖'
              : '刷新全场最高状元牌型，结算时确定奖品归属',
            tone: 'champion',
          };
        case 'improved':
          return {
            title: `博得${result.label} · 刷新自身状元成绩${outcome.locked ? '（已锁定）' : ''}`,
            detail: outcome.locked
              ? '原状元提高成绩并触发高阶锁定'
              : '原领先者提高自身状元成绩，继续保持领先',
            tone: 'champion',
          };
        case 'locked':
          return {
            title: `博得${result.label}`,
            detail: '本局状元已由高阶牌型锁定，本次未改变状元归属',
            tone: 'champion',
          };
        case 'tied':
          return {
            title: `博得${result.label}`,
            detail: '与当前状元同分（先到先得），未超过当前状元',
            tone: 'champion',
          };
        case 'lower':
          return {
            title: `博得${result.label}`,
            detail: '未超过当前状元，已记入投掷记录',
            tone: 'champion',
          };
        case 'legacy-unknown':
          return {
            title: `博得${result.label}`,
            detail: '旧记录未保存当次状元归属判定',
            tone: 'champion',
          };
      }
    }

    return { title: `博得${result.label}`, detail: '计入状元候选，结束时发给状元得主', tone: 'champion' };
  }
  if (result.prize !== null) {
    const content = room?.config.prizes[result.prize]?.content?.trim() ?? '';
    if (record.awarded === result.prize) {
      if (content !== '') {
        return {
          title: `博得${result.label} · 获得${content} ×1`,
          detail: '获得1份',
          tone: 'prize',
        };
      }
      return { title: `博得${result.label} · 获得1份`, detail: null, tone: 'prize' };
    }
    return { title: `博得${result.label}`, detail: '本档奖品已领完，本次未领到奖品', tone: 'empty' };
  }
  return { title: '好彩头留在下一掷', detail: `${result.label}，本次没有奖品`, tone: 'none' };
}

/** 读取玩家的上一掷记录：优先使用服务端独立持久化的 `player.lastRoll`。 */
export function resolvePlayerLastRoll(
  player: Player | null | undefined,
  history: readonly RollRecord[] = [],
): RollRecord | null {
  if (!player) return null;
  if (player.lastRoll !== undefined) return player.lastRoll;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item && item.playerId === player.id) return item;
  }
  return null;
}

export interface PersonalLastRollSummary {
  headline: string;
  detail: string;
  tone: RollHeadline['tone'];
}

/**
 * 格式化“我的上一掷”专属摘要（严格对齐设计稿 4.1 节各场景文案）。
 */
export function describePersonalLastRoll(
  record: RollRecord | null,
  room: RoomState,
): PersonalLastRollSummary {
  if (!record) {
    return {
      headline: '你的第一掷还未开始',
      detail: '轮到你时点击掷骰按钮开启好运',
      tone: 'none',
    };
  }
  if (record.reason === 'timeout' || record.result === null) {
    return {
      headline: '本次超时，已跳过',
      detail: `第 ${record.round} 轮 · 超时不掷骰、不发奖`,
      tone: 'empty',
    };
  }
  const { result } = record;
  if (result.prize === null) {
    return {
      headline: '本次未中奖 · 下一掷再来',
      detail: `第 ${record.round} 轮 · ${result.label}`,
      tone: 'none',
    };
  }
  if (result.prize !== 'zhuangyuan') {
    const content = room.config.prizes[result.prize]?.content?.trim() ?? '';
    if (record.awarded === result.prize) {
      return {
        headline: content !== '' ? `${result.label} · 获得${content} ×1` : `${result.label} · 获得 1 份`,
        detail: content !== '' ? `第 ${record.round} 轮 · 实得 1 份（${content}）` : `第 ${record.round} 轮 · 实得 1 份`,
        tone: 'prize',
      };
    }
    return {
      headline: `${result.label} · 本档奖品已领完，本次未领到奖品`,
      detail: `第 ${record.round} 轮 · 本档库存已空`,
      tone: 'empty',
    };
  }

  // 状元牌型：按当次 championOutcome 呈现事实
  const outcome = record.championOutcome;
  const matchedEvent = room.championEvents?.find((item) => item.recordId === record.id) ?? null;
  const fallbackNickname = outcome?.previousPlayerId
    ? (playerById(room, outcome.previousPlayerId)?.nickname ?? null)
    : null;
  const prevNickname = matchedEvent?.previousNickname ?? fallbackNickname ?? '前任';

  if (outcome) {
    switch (outcome.kind) {
      case 'first':
        return {
          headline: `${result.label} · 你成为当前状元，结算时确定奖品归属`,
          detail: `第 ${record.round} 轮${outcome.locked ? ' · 触发高阶锁定' : ''}`,
          tone: 'champion',
        };
      case 'takeover':
        return {
          headline: `${result.label} · 你顶替${prevNickname}，成为当前状元`,
          detail: `第 ${record.round} 轮${outcome.locked ? ' · 触发高阶锁定' : ''}`,
          tone: 'champion',
        };
      case 'improved':
        return {
          headline: `${result.label} · 你提高自身状元成绩，继续保持领先`,
          detail: `第 ${record.round} 轮${outcome.locked ? ' · 触发高阶锁定' : ''}`,
          tone: 'champion',
        };
      case 'locked':
        return {
          headline: `${result.label} · 本局状元已锁定，未改变当前状元归属`,
          detail: `第 ${record.round} 轮 · 已记入投掷记录`,
          tone: 'champion',
        };
      case 'tied':
      case 'lower':
        return {
          headline: `${result.label} · 未超过当前状元，已记入投掷记录`,
          detail: `第 ${record.round} 轮 · 掷出状元牌型但未登顶`,
          tone: 'champion',
        };
      case 'legacy-unknown':
        return {
          headline: `${result.label} · 旧局记录未保存当次状元归属判定`,
          detail: `第 ${record.round} 轮`,
          tone: 'champion',
        };
    }
  }
  return {
    headline: `${result.label} · 计入状元候选，结算时确定奖品归属`,
    detail: `第 ${record.round} 轮`,
    tone: 'champion',
  };
}

/**
 * 统计玩家在本局真实“登顶状元”的次数。
 * 契约规定：登顶次数只统计 `first` 与 `takeover`，本人提高成绩（`improved`）或仅掷出状元牌型不计入登顶次数。
 */
export function playerChampionReignCount(room: RoomState, playerId: string): number {
  const events = room.championEvents ?? [];
  return events.filter(
    (event) => event.playerId === playerId && (event.kind === 'first' || event.kind === 'takeover'),
  ).length;
}

export interface PersonalChampionExperience {
  reignCount: number;
  hasRolledChampionHand: boolean;
  isCurrentLeader: boolean;
  isLocked: boolean;
  isFinalWinner: boolean;
  shortBadge: string | null;
  statusTitle: string;
  statusDetail: string;
  overtakenNotice: string | null;
}

/**
 * 计算个人状元经历：严格区分“曾登顶当前状元”与“仅掷出过状元牌型但未登顶”。
 */
export function describePersonalChampionExperience(
  room: RoomState,
  playerId: string,
): PersonalChampionExperience {
  const me = playerById(room, playerId);
  const events = room.championEvents ?? [];
  const reignCount = playerChampionReignCount(room, playerId);
  const isCurrentLeader = room.champion?.playerId === playerId;
  const isLocked = Boolean(isCurrentLeader && room.champion?.locked);
  const zhuangyuanAwarded = me?.awards.zhuangyuan ?? 0;
  const isFinalWinner = room.status === 'finished' && zhuangyuanAwarded > 0;
  const hasRolledChampionHand =
    me?.best?.prize === 'zhuangyuan' ||
    room.history.some((item) => item.playerId === playerId && item.result?.prize === 'zhuangyuan');

  // 查找自己最近一次被他人顶替的事件
  const latestOvertake = [...events]
    .reverse()
    .find((event) => event.kind === 'takeover' && event.previousPlayerId === playerId);

  const overtakenNotice =
    !isCurrentLeader && reignCount > 0 && latestOvertake
      ? `${latestOvertake.nickname}以${latestOvertake.result.label}顶替了你；你的登顶经历已保留`
      : null;

  const zhuangyuanContent = room.config.prizes.zhuangyuan?.content?.trim() ?? '';

  if (isFinalWinner) {
    return {
      reignCount,
      hasRolledChampionHand: true,
      isCurrentLeader: true,
      isLocked,
      isFinalWinner: true,
      shortBadge: `最终状元 · 实得 ${zhuangyuanAwarded} 份`,
      statusTitle: '最终状元得主',
      statusDetail: `本局已结算，你实得状元奖 ${zhuangyuanAwarded} 份${zhuangyuanContent ? `（${zhuangyuanContent}）` : ''}，曾登顶 ${reignCount} 次。`,
      overtakenNotice: null,
    };
  }

  if (isCurrentLeader && room.champion) {
    return {
      reignCount,
      hasRolledChampionHand: true,
      isCurrentLeader: true,
      isLocked,
      isFinalWinner: false,
      shortBadge: isLocked ? '当前状元（已锁定）' : '当前状元领先中',
      statusTitle: isLocked ? '当前状元 · 已锁定得主' : '当前状元 · 暂时领先',
      statusDetail: isLocked
        ? `你以 ${room.champion.result.label} 锁定状元，整局结束时将获得全部 ${room.initialPool.zhuangyuan} 份状元奖${zhuangyuanContent ? `（${zhuangyuanContent}）` : ''}。`
        : `你以 ${room.champion.result.label} 暂列当前状元（曾登顶 ${reignCount} 次），整局结算时若未被顶替将获得状元奖。`,
      overtakenNotice: null,
    };
  }

  if (reignCount > 0) {
    return {
      reignCount,
      hasRolledChampionHand: true,
      isCurrentLeader: false,
      isLocked: false,
      isFinalWinner: false,
      shortBadge: `曾登顶 ${reignCount} 次（已被顶替）`,
      statusTitle: `曾登顶状元 ${reignCount} 次 · 已被顶替`,
      statusDetail:
        overtakenNotice ??
        `你本局曾登顶成为当前状元 ${reignCount} 次，后被更高牌型顶替，登顶经历已完整保留。`,
      overtakenNotice,
    };
  }

  if (hasRolledChampionHand) {
    return {
      reignCount: 0,
      hasRolledChampionHand: true,
      isCurrentLeader: false,
      isLocked: false,
      isFinalWinner: false,
      shortBadge: '曾掷出状元牌型（未登顶）',
      statusTitle: '曾掷出状元牌型，但未登顶',
      statusDetail: `你曾掷出状元牌型${me?.best ? `（${me.best.label}）` : ''}，因未超过当时的当前状元或状元已锁定，曾登顶次数计为 0 次。`,
      overtakenNotice: null,
    };
  }

  return {
    reignCount: 0,
    hasRolledChampionHand: false,
    isCurrentLeader: false,
    isLocked: false,
    isFinalWinner: false,
    shortBadge: null,
    statusTitle: '本局暂未登顶状元',
    statusDetail: room.championHistoryComplete === false
      ? '旧局部分历程未记录；目前没有可证实的个人登顶记录。'
      : '本局尚未掷出状元牌型，继续投掷冲击状元。',
    overtakenNotice: null,
  };
}

export interface ChampionEventDescription {
  tag: string;
  title: string;
  detail: string;
}

/** 格式化单条状元历程事件（首次/顶替/自己提高/锁定/最终发奖）。 */
export function describeChampionEvent(
  event: ChampionEvent,
  room?: RoomState | null,
): ChampionEventDescription {
  const lockSuffix = event.locked ? ' · 触发高阶锁定' : '';
  const zhuangyuanContent = room?.config.prizes.zhuangyuan?.content?.trim() ?? '';

  switch (event.kind) {
    case 'first':
      return {
        tag: event.locked ? '首次登顶·锁定' : '首次登顶',
        title: `${event.nickname} 首次登顶状元 · ${event.result.label}`,
        detail: `第 ${event.round} 轮 · 成为本局首位当前状元${lockSuffix}`,
      };
    case 'takeover':
      return {
        tag: event.locked ? '顶替夺魁·锁定' : '顶替夺魁',
        title: `${event.nickname} 以 ${event.result.label} 顶替 ${event.previousNickname ?? '前任'}`,
        detail: `第 ${event.round} 轮 · 前任：${event.previousNickname ?? '—'} → 新任：${event.nickname}${lockSuffix}`,
      };
    case 'improved':
      return {
        tag: event.locked ? '刷新成绩·锁定' : '刷新成绩',
        title: `${event.nickname} 将自身状元成绩提升至 ${event.result.label}`,
        detail: `第 ${event.round} 轮 · 原领先者自己提高成绩（不重复增加登顶次数）${lockSuffix}`,
      };
    case 'settled':
      return {
        tag: '最终发奖',
        title: `${event.nickname} 荣膺最终状元 · 实发 ${event.awardedCount} 份${zhuangyuanContent ? `（${zhuangyuanContent}）` : ''}`,
        detail: `第 ${event.round} 轮 · 夺魁牌型：${event.result.label}${event.locked ? '（高阶锁定）' : ''}`,
      };
  }
}

export function prizeLabelOf(key: PrizeKey): string {
  return PRIZE_META[key].label;
}

/** 当前状元领先者（用于奖池区金底卡与结算页）。 */
export function championPlayer(room: RoomState): Player | null {
  if (!room.champion) return null;
  return room.players.find((player) => player.id === room.champion?.playerId) ?? null;
}

/** 状元状态标题：严格区分“当前状元，仍可被顶替”、“状元已锁定”、“最终状元”。 */
export function championStatusTitle(room: RoomState): string {
  if (room.status === 'finished') return '最终状元';
  if (!room.champion) return '当前状元候选';
  if (room.champion.locked) return '状元已锁定';
  return '当前状元，仍可被顶替';
}

/** 触发高阶锁定的牌型中文名。 */
export function championLockedByLabel(room: RoomState): string | null {
  if (!room.champion?.locked) return null;
  const code = room.champion.lockedBy ?? room.champion.result.code;
  return resultRow(code).label;
}

export function playerById(room: RoomState, playerId: string | null): Player | null {
  if (!playerId) return null;
  return room.players.find((player) => player.id === playerId) ?? null;
}

/** 未离开成员，按入座顺序。 */
export function seatedPlayers(room: RoomState): Player[] {
  return room.players.filter((player) => !player.left).sort((a, b) => a.seat - b.seat);
}

export function currentTurnPlayer(room: RoomState): Player | null {
  return playerById(room, room.turnPlayerId);
}

/** 最近一条真实投掷记录（用于碗下方的结果说明）。 */
export function latestRoll(room: RoomState): RollRecord | null {
  for (let index = room.history.length - 1; index >= 0; index -= 1) {
    const record = room.history[index];
    if (record) return record;
  }
  return null;
}

export function resultOfDice(result: DiceResult | null): string {
  return result ? result.label : '';
}

export function formatRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${seconds} 秒`;
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 房主开始按钮的禁用原因（禁用时必须说明原因）。
 * 返回 null 表示可以开始。
 */
export function startBlockedReason(room: RoomState): string | null {
  const active = room.players.filter((player) => !player.left);
  if (active.length < 2) return '至少2位玩家在线并准备后才能开始';
  const offline = active.filter((player) => !player.online);
  if (offline.length > 0) return `等待 ${offline.map((player) => player.nickname).join('、')} 上线`;
  const notReady = active.filter((player) => !player.ready);
  if (notReady.length > 0) return `等待 ${notReady.map((player) => player.nickname).join('、')} 准备`;
  if (active.length > room.maxPlayers) return '人数超过上限';
  return null;
}

export const READY_BLOCKED_HINT = '至少2位玩家在线并准备后才能开始';
