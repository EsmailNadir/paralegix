import tseslint from 'typescript-eslint';

/**
 * Backend lint config.
 *
 * Deliberately narrow: this is not a style linter (the backend has never had one
 * and adding 366 files' worth of style opinions is not this change's job). It
 * enforces the one rule that has a data-leak consequence.
 */
const noDirectDrizzleClientRequire = {
  selector: "CallExpression[callee.name='require'][arguments.0.value=/drizzleClient$/]",
  message:
    'Import the scoped queryContext API instead of the unrestricted Drizzle client. '
    + 'Only queryContext may expose an executor to an audited callback.',
};

/**
 * `SqlRepository` was the legacy compatibility surface: a base class constructed
 * with a snake_case table NAME rather than a Drizzle table object. Nothing
 * extends it any more and the file is deleted, so this rule now guards against
 * the shape coming back rather than against it spreading. A repository extends
 * `DrizzleRepository`, or reaches for `tenantQuery` directly for anything with a
 * join or an aggregate.
 */
const noNewSqlRepository = {
  selector: "ClassDeclaration[superClass.name='SqlRepository'], ClassExpression[superClass.name='SqlRepository']",
  message:
    'SqlRepository is legacy and is not a pattern to copy. Extend DrizzleRepository, '
    + 'or use tenantQuery directly for anything with a join or an aggregate. '
    + 'See .claude/rules/backend-repository.md.',
};

const AUDITED_QUERY_CALLS = new Set([
  'adminQuery',
  'firmQuery',
  'systemQuery',
  'tenantQuery',
  'tokenQuery',
]);
const EXECUTOR_NAMES = new Set(['db', 'executor', 'queryExecutor', 'rootQueryExecutor', 'transaction', 'tx']);

const safeDrizzleBoundaryRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      unsafe:
        'Build Drizzle queries inside tenantQuery/systemQuery/adminQuery/tokenQuery, '
        + 'or use scopedWrite. Direct executor access can bypass tenant isolation.',
    },
  },
  create(context) {
    function enclosingAuditedCall(node) {
      for (let current = node.parent; current; current = current.parent) {
        if (
          current.type === 'CallExpression'
          && current.callee.type === 'Identifier'
          && AUDITED_QUERY_CALLS.has(current.callee.name)
        ) return true;
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (enclosingAuditedCall(node) || node.callee.type !== 'MemberExpression') return;
        const property = node.callee.property;
        const propertyName = property.type === 'Identifier' ? property.name : null;

        const isSelectFrom = propertyName === 'from'
          && node.callee.object?.type === 'CallExpression'
          && node.callee.object.callee?.type === 'MemberExpression'
          && node.callee.object.callee.property?.type === 'Identifier'
          && node.callee.object.callee.property.name === 'select';

        const receiver = node.callee.object;
        const isDirectWrite = ['insert', 'update', 'delete'].includes(propertyName)
          && receiver?.type === 'Identifier'
          && EXECUTOR_NAMES.has(receiver.name);

        if (isSelectFrom || isDirectWrite) context.report({ node, messageId: 'unsafe' });
      },
    };
  },
};

// Date's LOCAL getters (getFullYear/getMonth/getDate/getHours/getMinutes/getDay)
// read the SERVER PROCESS's ambient OS time zone, not an explicit one. That
// class of bug shipped twice in one afternoon: `shared/utils/reminderUtils.ts`'s
// `daysUntil` mis-counted "days until" a matter event depending on the
// deployment's local zone, and `shared/billing/firmBilling.service.ts`'s
// "due soon" bucket ignored the `timeZone` parameter it was already passed and
// used the server's local midnight instead. `toLocaleDateString`/`toLocaleTimeString`
// carry the identical risk: with no `timeZone` option they format in that same
// ambient zone, which shipped a real off-by-one-day due date in a client email
// (`stripe.service.ts`'s payment-request emails). Every fix pinned an explicit
// zone - UTC for a day-only value, the recipient's saved zone for a real
// instant - the same way `shared/utils/time.ts` and `shared/utils/localTime.ts`
// already do everywhere. This rule is the mechanical guard against the whole
// class coming back a third time; `toLocaleString` itself is deliberately NOT
// covered; it also exists on Number.prototype (money formatting), so a
// name-only check cannot tell the two apart without false positives.
// The LOCAL setters carry the same risk from the other side: `setHours(0, 0, 0, 0)`
// is the SERVER's midnight, which is how signing reminders counted days from a
// midnight no firm or signer is in.
const dateGetterNames = new Set([
  'getFullYear', 'getMonth', 'getDate', 'getHours', 'getMinutes', 'getDay',
  'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes',
]);
const localeDateFormatNames = new Set(['toLocaleDateString', 'toLocaleTimeString']);

const explicitDateTimezoneRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      localGetter:
        "'{{name}}' uses Date's LOCAL calendar day/hour - the SERVER PROCESS's ambient OS time zone, not an "
        + 'explicit one. Use the UTC variant (e.g. getUTCFullYear, setUTCDate) for a value already anchored to a UTC instant, '
        + "or Intl.DateTimeFormat with an explicit timeZone (shared/utils/time.ts's zonedDayString/formatForClient, "
        + "shared/utils/localTime.ts's localDateFor/localHourFor) when it needs a recipient's own zone.",
      missingTimeZone:
        "'{{name}}' formats a date in the SERVER PROCESS's ambient local time zone with no `timeZone` option. "
        + "Pass { timeZone: 'UTC' } for a day-only value, or the recipient's saved zone for a real instant.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') return;
        const property = node.callee.property;
        const name = property.type === 'Identifier' ? property.name : null;
        if (!name) return;

        if (dateGetterNames.has(name)) {
          context.report({ node, messageId: 'localGetter', data: { name } });
          return;
        }

        if (localeDateFormatNames.has(name)) {
          const optionsArg = node.arguments[1];
          // No options argument at all is definitely missing timeZone. A
          // present-but-non-literal argument (a variable, a spread) cannot be
          // checked statically and is left alone rather than risk a false
          // positive on an options object built (and zone-checked) elsewhere.
          if (!optionsArg) {
            context.report({ node, messageId: 'missingTimeZone', data: { name } });
            return;
          }
          if (optionsArg.type !== 'ObjectExpression') return;
          const hasTimeZone = optionsArg.properties.some(
            (p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'timeZone'
          );
          if (!hasTimeZone) context.report({ node, messageId: 'missingTimeZone', data: { name } });
        }
      },
    };
  },
};

export default [
  {
    // The generated Drizzle schema is machine-written and rewritten by
    // db/normalize-drizzle-schema.ts on every pull; linting it would report on
    // code nobody edits by hand.
    ignores: ['dist/**', 'dist-test/**', 'node_modules/**', 'src/shared/database/drizzle/**'],
  },
  {
    // The tree carries `eslint-disable` comments for rules this config does not
    // enable (no-await-in-loop and friends). They are not dead -- they document
    // deliberate choices -- so do not report them as unused. Revisit if this
    // config ever grows into a full style ruleset.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    // TypeScript needs its own parser: the default (espree) cannot read type
    // annotations and would fail with a parse error instead of applying the rule.
    // db/ and scripts/ are operator tooling rather than build output, but they
    // talk to the same database and the tenant-scoping rule applies there too.
    files: ['src/**/*.ts', 'db/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: {
      paralegix: {
        rules: {
          'safe-drizzle-boundary': safeDrizzleBoundaryRule,
          'explicit-date-timezone': explicitDateTimezoneRule,
        },
      },
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/drizzleClient'],
          message: 'Import the scoped queryContext API instead of the unrestricted Drizzle client.',
        }],
      }],
      'no-restricted-syntax': ['error', noDirectDrizzleClientRequire, noNewSqlRepository],
      'paralegix/safe-drizzle-boundary': 'error',
    },
  },
  {
    // Scoped to src/ only, not db/scripts/tests: `scripts/generate-signing-cert.ts`
    // sets a certificate's ~10-year expiry with a local getter (a day of drift on
    // a decade-long window is not the bug this guards), and `tests/live/`'s
    // fixture helpers shift a test date by N days for a real running server, not
    // a recipient-facing display or comparison. `src/` is where every real
    // instance of this bug shipped.
    files: ['src/**/*.ts'],
    rules: { 'paralegix/explicit-date-timezone': 'error' },
  },
  {
    // These are the reviewed boundary implementations. Callers receive an
    // executor only inside their audited callback and cannot import the root db.
    files: [
      'src/shared/database/drizzleClient.ts',
    'src/shared/database/queryContext.ts',
    'src/shared/database/scopedWrite.ts',
    'src/shared/database/DrizzleRepository.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
      'paralegix/safe-drizzle-boundary': 'off',
    },
  },
];
