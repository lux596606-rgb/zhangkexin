/**
 * 简笔画装饰的图形数据。
 *
 * 单独放一个不依赖 React 的文件，是为了让"哪个样式配哪张画"这件事能被单测直接钉住——
 * 不然改了映射关系只能靠肉眼看画面才发现。
 */

/** 装饰主题：'none' 表示这一侧不加简笔画。 */
export type SketchMotif = 'none' | 'cake' | 'hearts'

/**
 * 爱心路径。以心口为原点、尖角朝下、约 36×32 的尺寸；缩放由调用方给。
 * 两个半瓣各用一段三次贝塞尔，心口落在 (18, 9)、尖端落在 (18, 30)。
 */
export const HEART_PATH =
  'M18 30C18 30 2 19.6 2 9.8 2 4.4 6.4 1 11.4 1 15.2 1 17.4 3.4 18 5.2 18.6 3.4 20.8 1 24.6 1 29.6 1 34 4.4 34 9.8 34 19.6 18 30 18 30Z'

/** 2007 年出生 → 2026.10.11 满 19 周岁。蛋糕上的数字蜡烛直接用这个常量。 */
export const BIRTHDAY_AGE = 19

/**
 * 样式 → 左右两侧分别挂什么装饰。
 * 画面 2「生日快乐」是唯一需要两侧一起上的：蛋糕（含 19 岁数字蜡烛）在左、爱心在右。
 * 画面 4 的文字已经占满宽度，只在右侧挂爱心，不挤占文字。
 */
export const SKETCH_SIDES: Record<'galaxy' | 'birthday' | 'pig' | 'closing', { left: SketchMotif; right: SketchMotif }> = {
  galaxy: { left: 'none', right: 'none' },
  birthday: { left: 'cake', right: 'hearts' },
  pig: { left: 'none', right: 'none' },
  closing: { left: 'none', right: 'hearts' },
}
