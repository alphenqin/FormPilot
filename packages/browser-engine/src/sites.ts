export const SITE_PROFILES = [
  {
    id: 'tencent',
    name: '腾讯招聘',
    hosts: ['careers.tencent.com', 'join.qq.com'],
    entry: 'https://careers.tencent.com/',
    verification: 'native-controls-only',
  },
  {
    id: 'bytedance',
    name: '字节跳动招聘',
    hosts: ['jobs.bytedance.com', 'join.bytedance.com'],
    entry: 'https://jobs.bytedance.com/',
    verification: 'native-controls-only',
  },
  {
    id: 'xiaomi',
    name: '小米招聘',
    hosts: ['hr.xiaomi.com'],
    entry: 'https://hr.xiaomi.com/',
    verification: 'native-controls-only',
  },
] as const;
export function siteProfile(host: string) {
  return (
    SITE_PROFILES.find((site) =>
      (site.hosts as readonly string[]).includes(host.toLowerCase()),
    ) ?? {
      id: 'generic',
      name: '通用网页表单',
      hosts: [],
      entry: '',
      verification: 'native-controls-only',
    }
  );
}
