// P-23：业务日期/月份一律按 Asia/Shanghai 计算，与服务器所在时区解耦。
// Railway 默认 TZ=UTC，月初北京时间 0–8 点上传/建批的记录会被错归到上个月。
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

// en-CA 的区域格式恰好是 YYYY-MM-DD
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 业务日期 YYYY-MM-DD（上海时区） */
export function businessDate(now: Date): string {
  return formatter.format(now);
}

/** 业务月份 YYYY-MM（上海时区） */
export function businessMonth(now: Date): string {
  return businessDate(now).slice(0, 7);
}
