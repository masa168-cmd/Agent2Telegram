/**
 * Adapter #11 — pi-goal's custom dialogs (§4.6.4, shaped against pi-goal
 * 0.6.0).
 *
 * pi-goal builds its own components and hands them to `ui.custom`, so the only
 * thing to read is what the component renders. Three shapes are recognised by
 * their structure, not by their labels:
 *
 *   confirmation   a title ending in "Goal Draft" plus exactly two options
 *   question       one title, one option list
 *   questionnaire  a tab bar with two or more questions, then the active one
 *
 * Anything else that arrives through `custom` is reported as unsupported:
 * guessing at an unknown layout is how the old text matcher lost. pi-goal 0.7
 * changes the wording, the tab bar and the "Write your own answer" row, so the
 * parse below is deliberately narrow and fails closed.
 *
 * Cursor position is read from the render (`> ` marks the focused row), which
 * is what makes the move-then-Enter actions safe: the delta is computed from
 * the live screen, never from a remembered guess.
 */
import type { DialogAdapter, DialogItem, DialogModel, Question } from "../model.ts";
import { renderText, selectRow } from "./utils.ts";

type GoalShape =
  | { shape: "confirm"; title: string; message?: string; options: string[]; cursor: number }
  | { shape: "question"; title: string; message?: string; options: string[]; cursor: number }
  | {
      shape: "questionnaire";
      tabs: string[];
      /** Tabs whose answer is already in, marked with `✓` on screen. */
      answered: string[];
      title: string;
      options: string[];
      cursor: number;
    };

const BORDER = /^[\s─—\-_=]+$/;
const OPTION = /^\s*>?\s*(\d+)[.)]\s+(.+?)\s*$/;

const isOptionLine = (line: string) => OPTION.test(line);

/** Strip the cursor marker, the numbering and the "current" star. */
function parseOption(line: string): { label: string; focused: boolean } | undefined {
  const match = OPTION.exec(line);
  if (!match) return undefined;
  const focused = line.trimStart().startsWith(">");
  const label = match[2].replace(/[★✦]\s*$/, "").trim();
  return label.length > 0 ? { label, focused } : undefined;
}

/** The questionnaire tab bar: `←  □ scope   □ success   ✓ Submit  →`. */
export function parseTabs(line: string): string[] | undefined {
  if (!/[□✓■]/.test(line)) return undefined;
  if (!line.includes("←") && !line.includes("→")) return undefined;
  const tabs: string[] = [];
  const pattern = /[□✓■]\s+([^\s][^□✓■]*)/g;
  let match: RegExpExecArray | null = pattern.exec(line);
  while (match) {
    const label = match[1].trim();
    if (label.length > 0 && label !== "Submit") tabs.push(label);
    match = pattern.exec(line);
  }
  return tabs.length >= 2 ? tabs : undefined;
}

const answeredTabs = (line: string): string[] => {
  const tabs: string[] = [];
  const pattern = /✓\s+([^\s][^□✓■]*)/g;
  let match: RegExpExecArray | null = pattern.exec(line);
  while (match) {
    const label = match[1].trim();
    if (label.length > 0 && label !== "Submit") tabs.push(label);
    match = pattern.exec(line);
  }
  return tabs;
};

/** Read the three known pi-goal shapes out of a render, or nothing at all. */
export function parseGoalRender(render: string): GoalShape | undefined {
  const lines = render
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !BORDER.test(line) && line.trim().length > 0);
  if (lines.length < 2) return undefined;

  const optionLines = lines.filter(isOptionLine);
  if (optionLines.length === 0) return undefined;
  const options = optionLines.map((line) => parseOption(line)?.label ?? "").filter((label) => label.length > 0);
  if (options.length === 0) return undefined;
  const cursorIndex = optionLines.findIndex((line) => line.trimStart().startsWith(">"));

  const firstOption = lines.indexOf(optionLines[0]);
  const header = lines.slice(0, firstOption).map((line) => line.trim()).filter((line) => line.length > 0);

  // Shape 3: a tab bar above the question.
  const tabs = parseTabs(lines[0]);
  if (tabs) {
    const body = lines.slice(1, firstOption).map((line) => line.trim()).filter((line) => line.length > 0);
    return {
      shape: "questionnaire",
      tabs,
      answered: answeredTabs(lines[0]),
      title: body[0] ?? "Goal questions",
      options,
      cursor: cursorIndex >= 0 ? cursorIndex : 0,
    };
  }

  const title = header[0] ?? "";
  const message = header.length > 1 ? header.slice(1).join("\n") : undefined;
  const confirmed = /^Confirm\b.*\bGoal Draft$/i.test(title) && options.length === 2;
  return {
    shape: confirmed ? "confirm" : "question",
    title,
    message,
    options,
    cursor: cursorIndex >= 0 ? cursorIndex : 0,
  };
}

function itemsFor(options: string[], cursor: number): DialogItem[] {
  return options.map((label, index) => ({ key: `${index}:${label}`, label, focused: index === cursor }));
}

export const customGoalAdapter: DialogAdapter = {
  id: "goal-custom",

  detect(component, ctx) {
    if (ctx.entry?.kind !== "custom") return false;
    return parseGoalRender(renderText(component)) !== undefined;
  },

  read(component, ctx): DialogModel {
    const shape = parseGoalRender(renderText(component));
    if (!shape) return { kind: "unsupported", title: ctx.entry?.title, what: "goal-custom: render shape not recognised" };

    if (shape.shape === "confirm") {
      return { kind: "confirm", title: shape.title, message: shape.message };
    }

    const custom = shape.options.some((label) => /write your own answer/i.test(label));

    // One question, or a whole questionnaire: both are questionnaires to the
    // renderer, which only draws the active question's options.
    if (shape.shape === "question") {
      const question: Question = {
        id: "goal",
        prompt: shape.message ? `${shape.title}\n${shape.message}` : shape.title,
        multi: false,
        allowCustom: custom,
        answered: false,
        items: itemsFor(shape.options, shape.cursor),
      };
      return { kind: "questionnaire", title: shape.title, questions: [question], active: 0, canSubmit: false };
    }

    // Which tab is open is not on screen, so it is the one thing this adapter
    // tracks; the options it acts on are always read back from the render.
    const active = Math.min(memory.get(component)?.active ?? 0, shape.tabs.length - 1);
    const questions: Question[] = shape.tabs.map((tab, index) => ({
      id: tab,
      prompt: index === active ? shape.title : tab,
      multi: false,
      allowCustom: custom,
      answered: shape.answered.includes(tab),
      items: index === active ? itemsFor(shape.options, shape.cursor) : [],
    }));
    return {
      kind: "questionnaire",
      title: shape.tabs.join(" · "),
      questions,
      active,
      // Answering the last question submits, so there is no separate button.
      canSubmit: false,
    };
  },

  act(component, action, ctx) {
    const shape = parseGoalRender(renderText(component));
    if (!shape) return false;

    if (action.type === "cancel") {
      memory.delete(component);
      return ctx.sendKey("esc");
    }

    if (action.type === "confirm") {
      const target = action.yes ? 0 : 1;
      if (shape.options.length <= target) return false;
      return selectRow(ctx.sendKey, shape.cursor, target);
    }

    if (action.type === "question") {
      if (shape.shape !== "questionnaire") return false;
      const active = memory.get(component)?.active ?? 0;
      const steps = Math.abs(action.index - active);
      if (steps === 0 || action.index < 0 || action.index >= shape.tabs.length) return false;
      const name = action.index > active ? "tab" : "shift-tab";
      for (let step = 0; step < steps; step += 1) {
        if (!ctx.sendKey(name)) return false;
      }
      memory.set(component, { active: action.index });
      return true;
    }

    if (action.type === "choose" || action.type === "toggle") {
      const separator = action.key.indexOf(":");
      if (separator < 0) return false;
      const target = Number.parseInt(action.key.slice(0, separator), 10);
      if (!Number.isInteger(target) || target < 0 || target >= shape.options.length) return false;
      // Identity check: the label has to still sit on that row (§4.5 rule 3).
      if (action.key.slice(separator + 1) !== shape.options[target]) return false;
      return selectRow(ctx.sendKey, shape.cursor, target);
    }

    return false;
  },
};

/**
 * Which tab is open: the one piece of pi-goal state the render does not show.
 * Cleared when the dialog closes.
 */
const memory = new WeakMap<object, { active: number }>();
