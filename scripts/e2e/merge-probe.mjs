#!/usr/bin/env node
/**
 * Merge + compact the stage 0 probe runs into the committed host-probe files.
 *
 * The raw probe rewrites a full JSON document per event; the same editor
 * snapshot therefore repeats hundreds of times. This script keeps one
 * representative snapshot per component shape, folds the three pi-goal runs and
 * the OMP approval run into the main document, and writes the conclusions the
 * refactor plan backfills from.
 *
 * Usage:
 *   node scripts/e2e/merge-probe.mjs --host pi \
 *     --main /tmp/probe-pi-final.json \
 *     --goal-confirm /tmp/probe-goal-confirm.json \
 *     --goal-question /tmp/probe-goal-question.json \
 *     --goal-questionnaire /tmp/probe-goal-questionnaire2.json \
 *     --out docs/host-probe/pi-0.81.1.json
 *   node scripts/e2e/merge-probe.mjs --host omp \
 *     --main /tmp/probe-omp-final.json --approval /tmp/probe-omp-approval2.json \
 *     --out docs/host-probe/omp-18.12.5.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const HOST = argValue("--host", "pi");
const OUT = resolve(argValue("--out", `docs/host-probe/${HOST}.json`));
const paths = {
  main: argValue("--main"),
  approval: argValue("--approval"),
  confirm: argValue("--goal-confirm"),
  question: argValue("--goal-question"),
  questionnaire: argValue("--goal-questionnaire"),
};

function load(path) {
  if (!path || !existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function field(snapshot, name) {
  return snapshot?.fields?.[name]?.value;
}

function compactFocus(doc) {
  const types = {};
  const ref = (snapshot) => {
    if (!snapshot || snapshot.type !== "object") return snapshot;
    const key = `${snapshot.ctor ?? "?"}|${(snapshot.keys ?? []).join(",")}`;
    if (!(key in types)) types[key] = snapshot;
    return { typeRef: key };
  };
  const frames = [];
  for (const event of doc.focusEvents ?? []) {
    const data = event.data ?? {};
    data.focusRef = ref(data.focus);
    delete data.focus;
    delete data.current;
    data.hookSelectorRef = ref(data.hookSelector);
    data.hookInputRef = ref(data.hookInput);
    data.hookEditorRef = ref(data.hookEditor);
    delete data.hookSelector;
    delete data.hookInput;
    delete data.hookEditor;
    // A drawn frame is the only label source for hosts that keep dialog rows in
    // private fields, so keep every distinct frame once: the same shape draws a
    // different dialog each time (a select and a confirm share one class).
    if (data.rendered) {
      if (!frames.some((frame) => frame.rendered === data.rendered)) {
        frames.push({ ctor: data.constructor, keys: data.ownKeys, rendered: data.rendered });
      }
      delete data.rendered;
    }
  }
  doc.focusTypes = types;
  doc.frameSamples = frames;
  doc.chatChildren = (doc.chatChildren ?? []).map((event) => ({
    at: event.at,
    kind: event.kind,
    data: {
      ctor: event.data?.ctor,
      keys: event.data?.keys,
      shapes: event.data?.shapes,
      streamingComponent: event.data?.streamingComponent,
      sessionStreaming: event.data?.sessionStreaming,
    },
  }));
}

function piGoalShape(doc, label) {
  const candidates = (doc.customComponents ?? [])
    .filter((event) => event.data?.source === "showExtensionCustom")
    .filter((event) => !String(event.data?.render ?? "").includes("PROBE CUSTOM DIALOG"));
  const component = candidates[candidates.length - 1];
  if (!component) return { label, found: false };
  return {
    label,
    found: true,
    ctor: component.data.ctor,
    fieldKeys: component.data.fields?.keys ?? [],
    fields: component.data.fields?.fields ?? {},
    shapes: component.data.shapes,
    render: component.data.render,
    entryArgs: (doc.entryCalls ?? [])
      .filter((event) => event.data?.name === "showExtensionCustom")
      .slice(-1)[0]?.data?.args,
  };
}

function ompApproval(doc) {
  if (!doc) return undefined;
  return {
    entry: (doc.entryCalls ?? []).filter((event) => event.data?.name === "approve"),
    toolUi: (doc.entryCalls ?? []).find((event) => event.kind === "tool-ui")?.data,
    focus: (doc.focusEvents ?? []).find((event) => event.data?.constructor === "kj")?.data?.focus,
    focusTypes: (doc.focusEvents ?? []).find((event) => event.data?.constructor === "kj")?.data,
  };
}

const main = load(paths.main);
if (!main) {
  console.error(`missing --main ${paths.main}`);
  process.exit(1);
}

const modeKeys = main.mode?.keys ?? [];
const sessionKeys = main.session?.keys ?? [];
const editorSubmitObserved = (main.promptCalls ?? []).some((event) => event.kind === "editor-submit");
const editorCandidates = Object.entries(main.editors ?? {}).map(([name, snapshot]) => ({
  name,
  hasOnSubmitAtCapture: snapshot?.fields?.__onSubmit?.type === "function",
  hasOnSubmitObserved: editorSubmitObserved,
  hasHandleInput: snapshot?.fields?.__handleInput?.type === "function",
  hasGetText: snapshot?.fields?.__getText?.type === "function",
  keys: snapshot?.keys,
}));
const focusRead = main.focusRead ?? {};
const entryNames = [...new Set((main.entryCalls ?? []).map((event) => event.data?.name).filter(Boolean))];
const uiMethods = (main.entryCalls ?? []).find((event) => event.kind === "tool-ui")?.data?.methods;
const overlayWrapper = (main.focusEvents ?? []).some((event) =>
  event.data?.via === "setFocusInternal"
  && Array.isArray(event.data?.focus?.keys)
  && event.data.focus.keys.includes("component")
  && event.data.focus.keys.includes("overlayFocusRestore"));
const sessionAccessors = (main.prototype?.session ?? [])
  .filter((entry) => entry.kind === "accessor")
  .map((entry) => entry.name);

compactFocus(main);

// Framed dialogs on some hosts keep their rows in private fields: the frame is
// the label source T3.0's adapters parse, so record every frame a focus saw.
const ROW_MARKER = /^\s*(?:│\s*)?[→❯▸>]\s+\S/;
// A key-hint line lists at least two bindings ("↑/↓ navigate  ⏎ select  ⎋ cancel");
// one hit is usually a title or a tab label.
const KEY_HINTS = /navigate|submit|cancel|escape|ctrl\+c|enter|⎋|⏎|↑|↓|tab/i;
const keyHints = (line) => (line.match(new RegExp(KEY_HINTS, "gi")) ?? []).length;
const isKeyLine = (line) => keyHints(line) >= 2;
const isRule = (line) => line.trim() !== "" && /^[\s─━│|╭╮╰╯┌┐└┘]+$/.test(line);
const dialogFrames = (main.frameSamples ?? [])
  .map((sample) => {
    const lines = String(sample.rendered ?? "").split("\n");
    const boxed = lines[0]?.match(/^[╭┌][─\s]*(.*?)[─\s]*[╮┐]$/);
    const plainTitle = lines.find(
      (line) => line.trim() !== "" && !isRule(line) && !ROW_MARKER.test(line) && !isKeyLine(line),
    );
    return {
      ctor: sample.ctor,
      keys: sample.keys,
      title: (boxed?.[1] ?? plainTitle ?? "").replace(/[─\s]+$/, "").trim() || undefined,
      rows: lines.filter((line) => ROW_MARKER.test(line)).slice(0, 8),
      footer: lines.find(isKeyLine)?.trim(),
    };
  });

main.conclusions = {
  host: HOST,
  hostVersion: main.hostVersion,
  defaultEditor: {
    candidates: editorCandidates,
    field: HOST === "omp" ? "mode.editor" : "mode.defaultEditor",
    note: HOST === "omp"
      ? "mode.editor still has onSubmit === undefined at capture time; it is assigned only after init, so the instance hook must be installed by the per-second tick (editor-submit events were recorded during the probe). OMP has no defaultEditor."
      : "mode.defaultEditor and mode.editor are the same object; onSubmit exists after setupEditorSubmitHandler.",
  },
  focusRead: {
    pi: focusRead.hasGetFocused === false
      ? "No getFocused/getFocus; ui.focusedComponent is a data field that lags one read behind setFocus, so it is only usable for validation; the focus event itself is authoritative."
      : undefined,
    omp: focusRead.hasGetFocused ? "ui.getFocused() exists and returns the current focus (editor or dialog)." : undefined,
    focusedComponent: focusRead.focusedComponent,
    overlayWrapper,
    note: HOST === "omp"
      ? "OMP's setFocus receives the component directly; no {component, overlayFocusRestore} wrapper was observed."
      : "the overlay's setFocusInternal receives a {component, overlayFocusRestore} wrapper; take .component before classifying.",
  },
  dialogFrames,
  mainLoop: HOST === "omp"
    ? {
        pendingUserInputs: modeKeys.includes("pendingUserInputs"),
        onInputCallback: modeKeys.includes("onInputCallback"),
        composer: modeKeys.includes("composer"),
        sessionKeys,
        sessionAccessors,
        note: "OMP 18.12.5 has no mode.pendingUserInputs; session has isStreaming/isCompacting accessors. quietSince uses those two accessors + onInputCallback, falling back to the 60-second cap when unreadable.",
      }
    : {
        pendingUserInputs: modeKeys.includes("pendingUserInputs"),
        onInputCallback: modeKeys.includes("onInputCallback"),
        sessionKeys,
        note: "pi 0.81.1 has all three quietSince fields.",
      },
  entryMethods: entryNames,
  toolUiMethods: uiMethods,
  chatComponents: main.chatChildren ?? [],
  piGoal: paths.confirm || paths.question || paths.questionnaire
    ? {
        version: "0.6.0",
        confirmation: piGoalShape(load(paths.confirm), "confirmation"),
        question: piGoalShape(load(paths.question), "goal_question"),
        questionnaire: piGoalShape(load(paths.questionnaire), "goal_questionnaire"),
      }
    : undefined,
  ompApproval: HOST === "omp" ? ompApproval(load(paths.approval)) : undefined,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(main, null, 2)}\n`);
console.log(`wrote ${OUT}`);
console.log(`focus types: ${Object.keys(main.focusTypes ?? {}).length}, size: ${(JSON.stringify(main).length / 1024).toFixed(0)} KiB`);
