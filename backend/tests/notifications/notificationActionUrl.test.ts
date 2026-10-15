/**
 * Every in-app notification the backend creates names where it goes.
 *
 * A notification without an `actionUrl` marks itself read on click and opens
 * whatever the frontend can guess from its entity, which for a row with no
 * matter is nothing at all. Every producer builds the link it means, so this
 * keeps the next producer from leaving it out.
 *
 * Parsed rather than grepped: the phrase `createNotifications` also appears in
 * comments, and a text match cannot tell which object literal is the payload.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '..', '..', 'src');

/** The repository module every producer writes through. */
const REPOSITORY_IDENTIFIERS = new Set(['notificationsRepo']);

interface Producer {
  file: string;
  line: number;
  payload: ts.ObjectLiteralExpression;
}

function propertyNamed(literal: ts.ObjectLiteralExpression, name: string) {
  return literal.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === name);
}

/**
 * The payload object of a create call. `notifyNewAssignees` passes a
 * `buildPayload()` call rather than a literal; its payloads are the arrow
 * functions given as `buildPayload:` elsewhere, which `builtPayloads` collects.
 */
function payloadOf(call: ts.CallExpression): ts.ObjectLiteralExpression | 'built' | null {
  const arg = call.arguments[2];
  if (!arg) return null;
  if (ts.isObjectLiteralExpression(arg)) return arg;
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === 'buildPayload') {
    return 'built';
  }
  return null;
}

function isCreateCall(node: ts.CallExpression) {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'createNotifications';
  return ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && REPOSITORY_IDENTIFIERS.has(callee.expression.text)
    && (callee.name.text === 'create' || callee.name.text === 'createMany');
}

function scan() {
  const producers: Producer[] = [];
  const unreadable: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;

      const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
      const rel = path.relative(SRC, full);
      const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && isCreateCall(node)) {
          const payload = payloadOf(node);
          if (payload && payload !== 'built') producers.push({ file: rel, line: at(node), payload });
          if (!payload) unreadable.push(`${rel}:${at(node)}`);
        }
        // `buildPayload: () => ({ ... })`
        if (
          ts.isPropertyAssignment(node)
          && ts.isIdentifier(node.name) && node.name.text === 'buildPayload'
          && ts.isArrowFunction(node.initializer)
        ) {
          let body: ts.Node = node.initializer.body;
          while (ts.isParenthesizedExpression(body)) body = body.expression;
          if (ts.isObjectLiteralExpression(body)) producers.push({ file: rel, line: at(node), payload: body });
          else unreadable.push(`${rel}:${at(node)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(SRC);
  return { producers, unreadable };
}

describe('notification producers', () => {
  const { producers, unreadable } = scan();

  it('finds the producers it is guarding', () => {
    // A rename of createNotifications or the repository import would make every
    // assertion below pass over an empty list.
    expect(producers.length).toBeGreaterThanOrEqual(30);
  });

  it('passes every payload as a literal this test can read', () => {
    expect(unreadable).toEqual([]);
  });

  it('gives every notification an actionUrl', () => {
    const missing = producers
      .filter(({ payload }) => {
        const prop = propertyNamed(payload, 'actionUrl');
        if (!prop) return true;
        if (ts.isShorthandPropertyAssignment(prop)) return false;
        if (!ts.isPropertyAssignment(prop)) return true;
        const value = prop.initializer;
        return value.kind === ts.SyntaxKind.NullKeyword
          || (ts.isIdentifier(value) && value.text === 'undefined');
      })
      .map(({ file, line }) => `${file}:${line}`);

    expect(missing).toEqual([]);
  });
});
