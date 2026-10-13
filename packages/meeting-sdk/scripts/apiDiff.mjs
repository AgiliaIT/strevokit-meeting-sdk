// Compares two API Extractor reports declaration by declaration and member by member, classifying each change as
// breaking or additive per the package versioning rules (removals and changes break; additions are additive unless
// they add a required member to a type that tenants construct).

/** Types tenants construct and pass in: adding a required member to these breaks existing callers. */
export const INPUT_TYPES = new Set(["MeetingEngineOptions", "MeetingLogger"]);

const DECLARATION = /^export (?:declare )?(?:abstract )?(function|class|interface|type|const|enum|namespace) ([\w$]+)/;
const STRING_UNION = /^\|?\s*"[^"]*"(?:\s*\|\s*"[^"]*")*$/;
const MEMBER_NAME = /^(?:(?:readonly|static|public|protected|abstract|declare)\s+)*(\[[^\]]*\]|"[^"]*"|[\w$]+)/;

const normalize = (text) => text.replace(/\s+/g, " ").trim();

function reportCode(report) {
  const unix = report.replace(/\r\n?/g, "\n");
  const match = /```ts\n([\s\S]*?)\n```/.exec(unix);
  return (match ? match[1] : unix)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** Declarations in the report keyed by exported name. */
export function parseDeclarations(report) {
  const declarations = new Map();
  let current = null;
  for (const line of reportCode(report).split("\n")) {
    const match = DECLARATION.exec(line);
    if (match) {
      current = { kind: match[1], name: match[2], lines: [] };
      declarations.set(current.name, current);
    }
    current?.lines.push(line);
  }
  for (const declaration of declarations.values()) {
    declaration.text = normalize(declaration.lines.join("\n"));
    delete declaration.lines;
  }
  return declarations;
}

/** Splits the body of a `{ ... }` block into its top-level members, keyed by member name. */
function parseMembers(body) {
  const members = new Map();
  let depth = 0;
  let start = 0;
  const push = (end) => {
    const text = normalize(body.slice(start, end));
    start = end + 1;
    if (text === "") return;
    const name = MEMBER_NAME.exec(text)?.[1] ?? text;
    let key = name;
    for (let n = 2; members.has(key); n++) key = `${name}#${n}`;
    const afterName = text.slice(text.indexOf(name) + name.length);
    members.set(key, { text, optional: afterName.startsWith("?") });
  };
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "{" || char === "(") depth++;
    else if (char === "}" || char === ")") depth--;
    else if (char === ";" && depth === 0) push(i);
  }
  push(body.length);
  return members;
}

/**
 * `{ prefix, body }` when the text is exactly `prefix { body }` (optionally followed by `;`): an interface, class, or
 * object-literal member. Anything after the matching brace (such as `| null`) means it is not a plain block.
 */
function splitBlock(text) {
  const open = text.indexOf("{");
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      if (text.slice(i + 1).replace(/;?\s*$/, "") !== "") return null;
      return { prefix: normalize(text.slice(0, open)), body: text.slice(open + 1, i) };
    }
  }
  return null;
}

/** `{ head, params, tail }` for a method member `name(params): type`, or null when the text is not a method. */
function splitMethod(text) {
  const open = text.indexOf("(");
  if (open === -1 || /[:=]/.test(text.slice(0, open))) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if ("([{<".includes(text[i])) depth++;
    else if (")]}>".includes(text[i]) && --depth === 0) {
      return { head: text.slice(0, open), params: splitTopLevel(text.slice(open + 1, i)), tail: text.slice(i + 1) };
    }
  }
  return null;
}

/** Splits a parameter list at its top-level commas. */
function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if ("([{<".includes(list[i])) depth++;
    else if (")]}>".includes(list[i])) depth--;
    else if (list[i] === "," && depth === 0) {
      parts.push(normalize(list.slice(start, i)));
      start = i + 1;
    }
  }
  const last = normalize(list.slice(start));
  if (last !== "") parts.push(last);
  return parts;
}

/** True when `after` is the method `before` with optional parameters appended: existing calls still compile. */
function addsOptionalParameters(before, after) {
  const was = splitMethod(before);
  const now = splitMethod(after);
  if (!was || !now || was.head !== now.head || was.tail !== now.tail) return false;
  if (now.params.length <= was.params.length) return false;
  if (was.params.some((param, i) => param !== now.params[i])) return false;
  return now.params.slice(was.params.length).every((param) => /^[\w$]+\?\s*:/.test(param));
}

function compareMembers(path, previousBody, currentBody, isInput, result) {
  const previous = parseMembers(previousBody);
  const current = parseMembers(currentBody);
  for (const [key, before] of previous) {
    const after = current.get(key);
    if (!after) {
      result.breaking.push(`removed ${path}.${key}`);
      continue;
    }
    if (before.text === after.text) continue;
    if (addsOptionalParameters(before.text, after.text)) {
      result.additive.push(`added optional parameter to ${path}.${key}`);
      continue;
    }
    const beforeBlock = splitBlock(before.text);
    const afterBlock = splitBlock(after.text);
    if (beforeBlock && afterBlock && beforeBlock.prefix === afterBlock.prefix) {
      compareMembers(`${path}.${key}`, beforeBlock.body, afterBlock.body, isInput, result);
    } else {
      result.breaking.push(`changed ${path}.${key}`);
    }
  }
  for (const [key, after] of current) {
    if (previous.has(key)) continue;
    if (isInput && !after.optional) result.breaking.push(`added required ${path}.${key}`);
    else result.additive.push(`added ${path}.${key}`);
  }
}

function aliasValue(text) {
  const equals = text.indexOf("=");
  return normalize(text.slice(equals + 1).replace(/;\s*$/, ""));
}

function unionLiterals(value) {
  return new Set(value.match(/"[^"]*"/g) ?? []);
}

function compareDeclaration(before, after, result) {
  if (before.text === after.text) return;
  if (before.kind !== after.kind) {
    result.breaking.push(`changed ${before.name} from ${before.kind} to ${after.kind}`);
    return;
  }
  if (before.kind === "interface" || before.kind === "class") {
    const beforeBlock = splitBlock(before.text);
    const afterBlock = splitBlock(after.text);
    if (!beforeBlock || !afterBlock || beforeBlock.prefix !== afterBlock.prefix) {
      result.breaking.push(`changed ${before.name}`);
      return;
    }
    compareMembers(before.name, beforeBlock.body, afterBlock.body, INPUT_TYPES.has(before.name), result);
    return;
  }
  if (before.kind === "type") {
    const beforeValue = aliasValue(before.text);
    const afterValue = aliasValue(after.text);
    if (STRING_UNION.test(beforeValue) && STRING_UNION.test(afterValue)) {
      const previous = unionLiterals(beforeValue);
      const current = unionLiterals(afterValue);
      for (const literal of previous) if (!current.has(literal)) result.breaking.push(`removed ${before.name} ${literal}`);
      for (const literal of current) if (!previous.has(literal)) result.additive.push(`added ${before.name} ${literal}`);
      return;
    }
  }
  result.breaking.push(`changed ${before.name}`);
}

/** Classifies every difference between two API reports as breaking or additive. */
export function diffApiReports(previousReport, currentReport) {
  const previous = parseDeclarations(previousReport);
  const current = parseDeclarations(currentReport);
  const result = { breaking: [], additive: [] };
  for (const [name, before] of previous) {
    const after = current.get(name);
    if (after) compareDeclaration(before, after, result);
    else result.breaking.push(`removed ${name}`);
  }
  for (const name of current.keys()) {
    if (!previous.has(name)) result.additive.push(`added ${name}`);
  }
  return result;
}
