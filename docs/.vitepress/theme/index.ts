import DefaultTheme from 'vitepress/theme'
import { h, onMounted, watch, nextTick } from 'vue'
import { useRoute } from 'vitepress'
import DocsExport from './DocsExport.vue'
import './custom.css'

// The "Back to App" links are authored pointing at production
// (https://paralegix.com) so a JS-less / prod render is already correct. On the
// client we rewrite them to match wherever the docs are actually being viewed,
// so localhost and staging link to their own app instead of production.
const PROD_APP_URL = 'https://paralegix.com'

function resolveAppUrl(): string {
  if (typeof window === 'undefined') return PROD_APP_URL
  const host = window.location.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '') {
    return 'http://localhost:3000'
  }
  if (host.includes('staging')) return 'https://staging.paralegix.com'
  return PROD_APP_URL
}

// Point every "Back to App" link (nav + hero) at the app for the current host.
function patchBackToAppLinks(): void {
  if (typeof document === 'undefined') return
  const target = resolveAppUrl()
  if (target === PROD_APP_URL) return // authored value is already correct
  document
    .querySelectorAll<HTMLAnchorElement>(`a[href^="${PROD_APP_URL}"]`)
    .forEach((a) => {
      a.href = target
    })
}

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: { component: (name: string, comp: unknown) => void } }) {
    // Interactive "Export for AI" section picker, used on the docs home page and
    // the Export page.
    app.component('DocsExport', DocsExport)
  },
  // Wrap the default layout so we can re-run the link patch after the initial
  // mount and after every client-side route change (the hero button only exists
  // on the home page and is re-rendered on navigation).
  Layout: {
    setup() {
      const route = useRoute()
      onMounted(() => {
        patchBackToAppLinks()
        watch(
          () => route.path,
          () => nextTick(patchBackToAppLinks),
        )
      })
      return () => h(DefaultTheme.Layout)
    },
  },
}
