<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { withBase } from 'vitepress'

// One selectable group of pages, mirrors the JSON the build/dev server emits.
interface ExportPage {
  source: string
  title: string
  text: string
}
interface ExportSection {
  id: string
  title: string
  pages: ExportPage[]
}

const sections = ref<ExportSection[]>([])
const selected = ref<Record<string, boolean>>({})
const loading = ref(true)
const failed = ref(false)

onMounted(async () => {
  try {
    const res = await fetch(withBase('/paralegix-docs.json'))
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    sections.value = data.sections ?? []
    // Start with everything selected so "download all" is one click; users
    // uncheck the sections they do not need to shorten the file.
    for (const s of sections.value) selected.value[s.id] = true
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
})

const chosen = computed(() => sections.value.filter((s) => selected.value[s.id]))
const anyChosen = computed(() => chosen.value.length > 0)

const pageCount = computed(() =>
  chosen.value.reduce((n, s) => n + s.pages.length, 0),
)

// Human-readable size estimate of the current selection.
const sizeLabel = computed(() => {
  const chars = buildText().length
  if (!chars) return '0 KB'
  const kb = chars / 1024
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`
})

function selectAll() {
  for (const s of sections.value) selected.value[s.id] = true
}
function clearAll() {
  for (const s of sections.value) selected.value[s.id] = false
}

// Assemble the plain-text bundle for the chosen sections. Matches the format the
// backend generator uses so a picked subset looks like a trimmed full export.
function buildText(): string {
  if (!chosen.value.length) return ''
  const rule = '='.repeat(70)
  const parts = [
    'PARALEGIX DOCUMENTATION',
    'Selected sections: ' + chosen.value.map((s) => s.title).join(', '),
  ]
  for (const section of chosen.value) {
    for (const page of section.pages) {
      parts.push(`\n\n${rule}\nSource: ${page.source}\n${rule}\n\n${page.text}`)
    }
  }
  return parts.join('\n')
}

function download() {
  const blob = new Blob([buildText()], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'paralegix-docs.txt'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="docs-export">
    <p v-if="loading" class="docs-export__status">Loading sections…</p>

    <p v-else-if="failed" class="docs-export__status">
      The export is generated when the docs site is built. Run
      <code>npm run build</code> and <code>npm run preview</code>, or view the
      published docs, to use it.
    </p>

    <template v-else>
      <div class="docs-export__toolbar">
        <button type="button" class="docs-export__link" @click="selectAll">Select all</button>
        <span class="docs-export__sep">·</span>
        <button type="button" class="docs-export__link" @click="clearAll">Clear all</button>
      </div>

      <div class="docs-export__grid">
        <label v-for="section in sections" :key="section.id" class="docs-export__item">
          <input type="checkbox" v-model="selected[section.id]" />
          <span class="docs-export__item-title">{{ section.title }}</span>
          <span class="docs-export__item-count">{{ section.pages.length }}</span>
        </label>
      </div>

      <div class="docs-export__actions">
        <button
          type="button"
          class="docs-download-button"
          :disabled="!anyChosen"
          @click="download"
        >
          Download selected (.txt)
        </button>
        <span v-if="anyChosen" class="docs-export__meta">
          {{ pageCount }} page{{ pageCount === 1 ? '' : 's' }} · ~{{ sizeLabel }}
        </span>
        <span v-else class="docs-export__meta">Pick at least one section</span>
      </div>
    </template>
  </div>
</template>
