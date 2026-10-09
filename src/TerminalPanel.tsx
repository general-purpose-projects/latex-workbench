import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type TerminalOutput = { id: number; data: string };

type Props = {
  projectRoot: string;
  active: boolean;
};

export default function TerminalPanel({ projectRoot, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalId = useRef<number | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: "#111a16",
        foreground: "#dce7e0",
        cursor: "#62d09d",
        selectionBackground: "#315b48",
      },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<TerminalOutput>("terminal-output", (event) => {
      if (event.payload.id === terminalId.current) terminal.write(event.payload.data);
    }).then((stop) => { unlisten = stop; });

    void invoke<number>("start_terminal", { projectRoot }).then((id) => {
      if (disposed) {
        void invoke("stop_terminal", { id });
        return;
      }
      terminalId.current = id;
      fit.fit();
      void invoke("resize_terminal", { id, cols: terminal.cols, rows: terminal.rows });
    }).catch((error) => terminal.writeln(`\r\n\x1b[31m${String(error)}\x1b[0m`));

    const input = terminal.onData((data) => {
      if (terminalId.current !== null) void invoke("write_terminal", { id: terminalId.current, data });
    });
    const observer = new ResizeObserver(() => {
      if (!activeRef.current || terminalId.current === null) return;
      fit.fit();
      void invoke("resize_terminal", { id: terminalId.current, cols: terminal.cols, rows: terminal.rows });
    });
    observer.observe(hostRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      unlisten?.();
      if (terminalId.current !== null) void invoke("stop_terminal", { id: terminalId.current });
      terminal.dispose();
    };
  }, [projectRoot]);

  useEffect(() => {
    if (!active || terminalId.current === null) return;
    window.requestAnimationFrame(() => fitRef.current?.fit());
  }, [active]);

  return <div ref={hostRef} className="terminal-host" />;
}
