/**
 * Terminal control-sequence helpers.
 */

/**
 * Strip terminal control sequences from a rendered line. Color (SGR) codes are
 * the common case, but hosts also park the hardware cursor inside components
 * (pi's input renders an APC string: ESC _ <payload> BEL) and move it with CSI
 * sequences; any of those left in the text corrupts the rendered output.
 * Deliberately dependency-free.
 */
export function stripAnsi(text: string): string {
  return text
    // CSI: colors, cursor movement, erase.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    // OSC: window titles, hyperlinks (BEL or ST terminated).
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
    // APC / PM / SOS / DCS strings (BEL or ST terminated).
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B[_PX^][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
    // Two-byte escapes: charset designators, keypad modes, ST.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B[()#][0-9A-Za-z]|\x1B[@-_]/g, "");
}
