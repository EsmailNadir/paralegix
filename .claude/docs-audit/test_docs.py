"""Regression checks for executable contracts in agent-facing docs."""

import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class AuditChecks(unittest.TestCase):
    def test_frontend_guard_inventory(self):
        scripts = json.loads((ROOT / 'frontend/package.json').read_text())['scripts']
        guards = [
            step.strip().removeprefix('npm run ')
            for step in scripts['ci:checks'].split('&&')
            if step.strip().startswith('npm run check:')
        ]
        self.assertTrue(guards, 'The gate must contain guards before checking its inventory')
        for doc in ['frontend/AGENTS.md', '.claude/agents/check-builds.md']:
            for guard in guards:
                with self.subTest(doc=doc, guard=guard):
                    self.assertTrue(f'`{guard}`' in (ROOT / doc).read_text())

    def test_shared_layout_build_documented(self):
        for package in ['backend', 'frontend']:
            with self.subTest(package=package):
                scripts = json.loads((ROOT / package / 'package.json').read_text())['scripts']
                self.assertIn('document-layout/tsconfig.json', scripts['build'])
                self.assertTrue('document-layout' in (ROOT / package / 'AGENTS.md').read_text())

    def test_pointers(self):
        for package in ['', 'backend', 'frontend', 'docs']:
            with self.subTest(package=package):
                self.assertEqual((ROOT / package / 'CLAUDE.md').read_text(), '@AGENTS.md\n')

    def test_side_effect_invocation_gate(self):
        for skill, requires_gate in [('local-database', True), ('red-team', False)]:
            with self.subTest(skill=skill):
                frontmatter = (ROOT / '.claude/skills' / skill / 'SKILL.md').read_text().split('---')[1]
                self.assertEqual('disable-model-invocation: true' in frontmatter, requires_gate)


if __name__ == '__main__':
    unittest.main()
