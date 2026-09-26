/**
 * 房间页编排：邀请落地 → 等待区 → 对局区 → 结算区，以及分享/规则/确认三个弹层。
 *
 * 身份恢复：本浏览器存有该房间凭证时直接以成员身份进入（先 GET 权威快照再订阅）；
 * 凭证失效只清理当前房间的记录，并回到落地页说明原因。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Membership } from '../../shared/types.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Dialog } from '../components/Dialog.js';
import { GameBoard } from '../components/GameBoard.js';
import { Results } from '../components/Results.js';
import { RoomHeader } from '../components/RoomHeader.js';
import { RoomLanding } from '../components/RoomLanding.js';
import { RulesContent } from '../components/RulesContent.js';
import { ShareDialog } from '../components/ShareDialog.js';
import { SiteHeader } from '../components/SiteHeader.js';
import { WaitingRoom } from '../components/WaitingRoom.js';
import { useDiceAnimation } from '../hooks/useDiceAnimation.js';
import { useRoom } from '../hooks/useRoom.js';
import { useInviteUrl } from '../hooks/useShareBaseUrl.js';
import { useSoundSettings } from '../hooks/useSoundSettings.js';
import { createDiceSound } from '../lib/dice-sound.js';
import type { DiceSoundController } from '../lib/dice-sound.js';
import { isValidRoomCode, Link, navigate, useTitle } from '../lib/router.js';
import { clearMembership, loadMembership } from '../lib/session.js';

interface MemberViewProps {
  code: string;
  membership: Membership;
  onInvalid: (message: string) => void;
  onLeft: () => void;
}

function MemberView({ code, membership, onInvalid, onLeft }: MemberViewProps): ReactElement {
  const { room, playerId, loading, fatal, loadError, retry, connection, actionMessage, clearActionMessage, busy, rollPending, now, runAction, roll } =
    useRoom(code, membership.token);
  const { dice, spinning, revealed, phase, settledCount } = useDiceAnimation(room, playerId, rollPending);
  const { enabled: soundEnabled, setEnabled: setSoundEnabled } = useSoundSettings();

  const soundRef = useRef<DiceSoundController | null>(null);
  const getSound = useCallback((): DiceSoundController => {
    if (!soundRef.current) {
      soundRef.current = createDiceSound();
    }
    return soundRef.current;
  }, []);

  useEffect(() => {
    if (!soundRef.current) {
      soundRef.current = createDiceSound();
    }
    return () => {
      soundRef.current?.dispose();
      soundRef.current = null;
    };
  }, []);

  // 请求失败或静音时立即停止正在播放的音效
  useEffect(() => {
    if (!soundEnabled || (actionMessage !== null && !rollPending && !spinning)) {
      soundRef.current?.stop();
    }
  }, [soundEnabled, actionMessage, rollPending, spinning]);

  const [shareOpen, setShareOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [confirm, setConfirm] = useState<'end' | 'leave' | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  useTitle(room ? `${room.name} · 月满博饼` : '月满博饼');

  useEffect(() => {
    if (fatal?.code === 'INVALID_TOKEN') onInvalid(fatal.message);
  }, [fatal, onInvalid]);

  const inviteUrl = useInviteUrl(code);
  const isHost = room?.hostId === playerId;

  const handleToggleSound = useCallback((): void => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    if (next) {
      void getSound().unlock();
    } else {
      soundRef.current?.stop();
    }
  }, [soundEnabled, setSoundEnabled, getSound]);

  const handleRoll = useCallback((): void => {
    if (
      soundEnabled &&
      room &&
      room.status === 'playing' &&
      room.turnId &&
      room.turnPlayerId === playerId &&
      connection === 'connected' &&
      !rollPending &&
      !spinning &&
      !room.paused
    ) {
      const sound = getSound();
      void sound.unlock();
      sound.start();
    }
    void roll();
  }, [soundEnabled, room, playerId, connection, rollPending, spinning, getSound, roll]);

  const handleLeave = useCallback(async (): Promise<void> => {
    setLeaveError(null);
    const outcome = await runAction({ type: 'leave' });
    if (outcome.ok) {
      const me = outcome.room?.players.find((player) => player.id === playerId);
      const leftConfirmed = !outcome.room || outcome.room.status === 'closed' || me === undefined || me.left;
      if (!leftConfirmed) {
        setLeaveError('服务端还没有确认你的离开，请稍后重试。');
        return;
      }
      setConfirm(null);
      clearMembership(code);
      onLeft();
      return;
    }

    const errorCode = outcome.error?.code ?? null;
    if (errorCode === 'INVALID_TOKEN' || errorCode === 'ROOM_NOT_FOUND' || errorCode === 'ROOM_EXPIRED' || errorCode === 'INVALID_INPUT') {
      setConfirm(null);
      clearMembership(code);
      onLeft();
      return;
    }

    setConfirm('leave');
    setLeaveError('离开没有成功（网络异常），你仍在房间里，身份也已保留，可以重试。');
  }, [code, onLeft, playerId, runAction]);

  if (loading && !room) {
    return (
      <div className="room-view">
        <p className="room-loading" role="status">
          正在进入房间…
        </p>
      </div>
    );
  }

  if (!room && loadError) {
    return (
      <div className="room-view">
        <section className="card room-status-card">
          <h1 className="section-title">暂时无法进入房间</h1>
          <p className="landing-status" role="alert">
            {loadError.message}
          </p>
          <p className="form-footnote">本机保存的房间身份仍然保留，网络恢复后点“重试”即可用原来的席位继续。</p>
          <div className="landing-actions">
            <button type="button" className="btn btn-primary" onClick={retry}>
              重试
            </button>
            <Link className="btn btn-secondary" to="/">
              回首页
            </Link>
          </div>
        </section>
      </div>
    );
  }

  if (!room && fatal) {
    return (
      <div className="room-view">
        <section className="card room-status-card">
          <h1 className="section-title">{fatal.code === 'ROOM_EXPIRED' ? '这桌已散席' : '无法进入这桌'}</h1>
          <p className="landing-status" role="alert">
            {fatal.message}
          </p>
          <div className="landing-actions">
            <Link className="btn btn-primary" to="/">
              回首页
            </Link>
          </div>
        </section>
      </div>
    );
  }

  if (!room) return <div className="room-view" />;

  return (
    <div className="room-view">
      <RoomHeader
        room={room}
        connection={connection}
        isHost={Boolean(isHost)}
        showHostEnd={room.status === 'playing'}
        soundEnabled={soundEnabled}
        onToggleSound={handleToggleSound}
        onInvite={() => setShareOpen(true)}
        onRules={() => setRulesOpen(true)}
        onEndRequest={() => setConfirm('end')}
        onLeaveRequest={() => setConfirm('leave')}
      />

      {actionMessage ? (
        <p className="form-error form-error--banner" role="alert">
          {actionMessage.text}
          <button type="button" className="link-button" onClick={clearActionMessage}>
            知道了
          </button>
        </p>
      ) : null}

      {room.status === 'waiting' ? (
        <WaitingRoom
          room={room}
          playerId={playerId}
          isHost={Boolean(isHost)}
          busy={busy}
          onReady={(ready) => void runAction({ type: 'ready', ready })}
          onStart={() => void runAction({ type: 'start' })}
          onInvite={() => setShareOpen(true)}
          onUpdateConfig={(config) => runAction({ type: 'update-config', config })}
        />
      ) : null}

      {room.status === 'playing' ? (
        <GameBoard
          room={room}
          playerId={playerId}
          connection={connection}
          rollPending={rollPending}
          spinning={spinning}
          phase={phase}
          settledCount={settledCount}
          dice={dice}
          revealed={revealed}
          now={now}
          onRoll={handleRoll}
        />
      ) : null}

      {room.status === 'finished' ? (
        <>
          <Results
            room={room}
            playerId={playerId}
            isHost={Boolean(isHost)}
            busy={busy}
            onRematch={() => void runAction({ type: 'rematch' })}
            onLeaveRequest={() => setConfirm('leave')}
          />
          <p className="results-footnote">再开一局会沿用本房间的房规与奖品配置，并重置本局库存与统计记录。</p>
        </>
      ) : null}

      {room.status === 'closed' ? (
        <section className="card closed-card">
          <h2 className="section-title">这桌已散席</h2>
          <p className="landing-status">所有玩家都已离开。可以回到首页重新开一桌。</p>
          <Link className="btn btn-primary" to="/">
            回首页
          </Link>
        </section>
      ) : null}

      <ShareDialog open={shareOpen} roomCode={room.code} roomName={room.name} inviteUrl={inviteUrl} onClose={() => setShareOpen(false)} />

      <Dialog open={rulesOpen} title={`${room.ruleset.name} · 房间规则`} onClose={() => setRulesOpen(false)} width="lg">
        <RulesContent compact room={room} />
      </Dialog>

      <ConfirmDialog
        open={confirm === 'end'}
        title="提前结束本局？"
        description="所有已发出的奖品会保留，并按当前状元领先者结算本局。结束后可以马上再开一局。"
        confirmLabel="确认结束"
        cancelLabel="继续博饼"
        busy={busy}
        onConfirm={() => {
          setConfirm(null);
          void runAction({ type: 'end' });
        }}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'leave'}
        title="离开房间？"
        description="离开后你在这桌的席位会标记为离开：本局已经开始的话，这一局不能再重新加入，只能等下一局；本局记录会保留。"
        confirmLabel="确认离开"
        cancelLabel="留在房间"
        danger
        busy={busy}
        error={leaveError}
        onConfirm={() => void handleLeave()}
        onCancel={() => {
          setLeaveError(null);
          setConfirm(null);
        }}
      />
    </div>
  );
}

export function Room({ code }: { code: string }): ReactElement {
  const [membership, setMembership] = useState<Membership | null>(() => loadMembership(code));
  const [notice, setNotice] = useState<string | null>(null);
  useTitle('月满博饼 · 房间');

  useEffect(() => {
    setMembership(loadMembership(code));
    setNotice(null);
  }, [code]);

  const handleInvalid = useCallback(
    (message: string): void => {
      clearMembership(code);
      setMembership(null);
      setNotice(`${message}（这台设备上原来的入席记录已清除，重新输入昵称即可入席）`);
    },
    [code],
  );

  const handleLeft = useCallback((): void => {
    navigate('/');
  }, []);

  if (!isValidRoomCode(code)) {
    return (
      <div className="page">
        <SiteHeader />
        <main className="container room-main">
          <section className="card closed-card">
            <h2 className="section-title">没找到这个房间</h2>
            <p className="landing-status" role="alert">
              房间码是6位字母或数字，请检查邀请链接后重试。
            </p>
            <Link className="btn btn-primary" to="/">
              回首页
            </Link>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <SiteHeader />
      <main className="container room-main">
        {membership ? (
          <MemberView key={`${code}:${membership.playerId}`} code={code} membership={membership} onInvalid={handleInvalid} onLeft={handleLeft} />
        ) : (
          <RoomLanding code={code} notice={notice} onJoined={setMembership} />
        )}
      </main>
    </div>
  );
}
