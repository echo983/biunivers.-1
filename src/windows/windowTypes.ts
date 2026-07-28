import type { Root } from "react-dom/client";
import type WinBox from "winbox/src/js/winbox.js";

export interface WindowRuntime {
  winbox: WinBox;
  reactRoot: Root;
  container: HTMLDivElement;
  closing: boolean;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
