import { useEffect } from "react";
import { listenForHookEvents, listenForHookLogs } from "./tauriBridge";
import { useOfficeStore } from "./store";

/** Connects the React UI to the Tauri hook backend. */
export function useTauriBridge(): void {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const loadLogs = (): void => {
      void useOfficeStore.getState().loadBridgeLogs();
    };
    const loadHistory = (): void => {
      void useOfficeStore.getState().loadBridgeHistory();
    };

    const connect = async (): Promise<void> => {
      useOfficeStore.getState().setBridgeState({ status: "connecting", error: undefined });

      try {
        const eventUnlisten = await listenForHookEvents({
          onEvent: ({ event }) => {
            useOfficeStore.getState().applyHookEvent({ event });
          },
          onError: ({ error }) => useOfficeStore.getState().setBridgeState({ status: "error", error }),
        });
        const logUnlisten = await listenForHookLogs({
          onLog: ({ log }) => useOfficeStore.getState().applyBridgeLog({ log }),
          onError: ({ error }) => useOfficeStore.getState().setBridgeState({ status: "error", error }),
        });

        if (disposed) {
          eventUnlisten();
          logUnlisten();
          return;
        }
        unlisteners.push(eventUnlisten, logUnlisten);

        loadHistory();
        loadLogs();
        useOfficeStore.getState().setBridgeState({ status: "connected", error: undefined });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        useOfficeStore.getState().setBridgeState({
          status: "error",
          error: `Tauri hook 后端不可用：${message}`,
        });
      }
    };

    void connect();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
      useOfficeStore.getState().setBridgeState({ status: "disconnected", error: undefined });
    };
  }, []);
}
