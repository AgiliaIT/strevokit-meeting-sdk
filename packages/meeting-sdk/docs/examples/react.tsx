// A minimal React integration: one hook that owns the engine, plus a few buttons. Not a UI kit.
import { useEffect, useReducer, useRef, useState } from "react";
import {
  createMeetingEngine,
  MeetingError,
  type ConnectionState,
  type MeetingEngine,
} from "@strevokit/meeting-sdk";

export function useMeetingEngine(token: string, realtimeUrl: string) {
  const [engine, setEngine] = useState<MeetingEngine | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<MeetingError | null>(null);
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    setError(null);
    setState("idle");
    let next: MeetingEngine;
    try {
      next = createMeetingEngine({ token, realtimeUrl });
    } catch (reason) {
      if (!(reason instanceof MeetingError)) throw reason;
      setError(reason);
      setEngine(null);
      return;
    }
    const unsubscribe = [
      next.on("state_changed", (event) => setState(event.state)),
      next.on("joined", refresh),
      next.on("participant_joined", refresh),
      next.on("participant_left", refresh),
      next.on("participant_media_changed", refresh),
      next.on("local_media_changed", refresh),
      next.on("error", (event) => setError(event.error)),
      next.on("closed", (event) => setError(event.error ?? null)),
    ];
    setEngine(next);
    next.join().catch((reason: unknown) => {
      if (reason instanceof MeetingError && reason.code !== "join_cancelled") setError(reason);
    });
    return () => {
      for (const off of unsubscribe) off();
      next.dispose();
    };
  }, [token, realtimeUrl]);

  return { engine, state, error };
}

function SelfPreview({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline width={320} />;
}

function RemoteParticipant({ engine, participantId }: { engine: MeetingEngine; participantId: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [status, setStatus] = useState(() => engine.mediaConnectionStatus(participantId));

  useEffect(() => {
    const attach = () => {
      const media = engine.remoteMedia(participantId);
      if (video.current) video.current.srcObject = media.camera;
      if (audio.current) audio.current.srcObject = media.microphone;
    };
    attach();
    const unsubscribe = [
      engine.on("remote_media_changed", (event) => {
        if (event.participantId === participantId) attach();
      }),
      engine.on("media_connection_changed", (event) => {
        if (event.participantId === participantId) setStatus(event.status);
      }),
    ];
    return () => {
      for (const off of unsubscribe) off();
    };
  }, [engine, participantId]);

  return (
    <figure>
      <video ref={video} autoPlay muted playsInline width={320} />
      <audio ref={audio} autoPlay />
      <figcaption>{status === "interrupted" ? "Connection lost — reconnecting…" : status}</figcaption>
    </figure>
  );
}

export function Meeting({ token, realtimeUrl }: { token: string; realtimeUrl: string }) {
  const { engine, state, error } = useMeetingEngine(token, realtimeUrl);
  if (!engine) return error ? <p role="alert">{error.message}</p> : null;

  const media = engine.localMediaState;
  const run = (action: () => Promise<void>) => {
    action().catch((reason: unknown) => {
      if (reason instanceof MeetingError) alert(reason.message);
    });
  };

  return (
    <section>
      <p>{error ? error.message : state}</p>
      <SelfPreview stream={engine.localMedia.camera} />
      <div role="group" aria-label="Media controls">
        <button
          aria-pressed={media.camera}
          disabled={state !== "joined"}
          onClick={() => run(() => (media.camera ? engine.disableCamera() : engine.enableCamera()))}
        >
          Camera
        </button>
        <button
          aria-pressed={media.microphone}
          disabled={state !== "joined"}
          onClick={() => run(() => (media.microphone ? engine.mute() : engine.unmute()))}
        >
          Microphone
        </button>
        <button
          aria-pressed={media.screen}
          disabled={state !== "joined"}
          onClick={() => run(() => (media.screen ? engine.stopScreenShare() : engine.startScreenShare()))}
        >
          Share screen
        </button>
        <button disabled={state !== "joined"} onClick={() => void engine.leave()}>
          Leave
        </button>
      </div>
      <ul>
        {engine.participants.map((participant) => (
          <li key={participant.id}>
            {participant.displayName ?? participant.id} ({participant.role})
            <RemoteParticipant engine={engine} participantId={participant.id} />
          </li>
        ))}
      </ul>
    </section>
  );
}
