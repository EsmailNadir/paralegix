export function canPreviewCalendarConnections(nodeEnv: string | undefined, hostname: string): boolean {
  return nodeEnv === 'development'
    && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase());
}
