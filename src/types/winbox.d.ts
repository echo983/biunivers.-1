declare module "winbox/src/js/winbox.js" {
  interface WinBoxOptions {
    id?: string;
    title?: string;
    icon?: string;
    root?: HTMLElement;
    mount?: HTMLElement;
    class?: string | string[];
    x?: number | string;
    y?: number | string;
    width?: number | string;
    height?: number | string;
    minwidth?: number;
    minheight?: number;
    bottom?: number;
    onfocus?: () => void;
    onblur?: () => void;
    onmove?: (x: number, y: number) => void;
    onresize?: (width: number, height: number) => void;
    onmaximize?: () => void;
    onrestore?: () => void;
    onclose?: (force?: boolean) => boolean | void;
  }

  export default class WinBox {
    constructor(options?: WinBoxOptions);
    x: number;
    y: number;
    width: number;
    height: number;
    max: boolean;
    hidden: boolean;
    focused: boolean;
    show(state?: boolean): this | undefined;
    hide(state?: boolean): this | undefined;
    focus(state?: boolean): this;
    blur(state?: boolean): this;
    maximize(state?: boolean): this;
    restore(): this;
    resize(width?: number | string, height?: number | string): this;
    move(x?: number | string, y?: number | string): this;
    close(force?: boolean): boolean | void;
  }
}
