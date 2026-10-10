import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from './App'
import { giftCopy } from './content/giftCopy'

function sectionMarkup(page: string, section: string) {
  const start = page.indexOf(`aria-labelledby="${section}-title"`)
  if (start === -1) throw new Error(`缺少 ${section} 内容区`)
  return page.slice(start, page.indexOf('</section>', start))
}

describe('连续阅读的生日礼物', () => {
  it('七个内容段落同时出现在页面里，不再一次只渲染一幕', () => {
    const page = renderToStaticMarkup(<App />)
    const sections = ['hero', 'stars', 'birthday', 'photo', 'pig', 'letter', 'wish']
    let previous = -1
    for (const section of sections) {
      const position = page.indexOf(`aria-labelledby="${section}-title"`)
      expect(position, section).toBeGreaterThan(previous)
      previous = position
    }
  })

  it('整封信直接可读，不需要逐句点击展开', () => {
    const page = renderToStaticMarkup(<App />)
    for (const paragraph of giftCopy.letter.paragraphs) expect(page).toContain(paragraph)
    expect(page).not.toContain('letter-salutation')
    expect(page).not.toContain('letter-signoff')
  })

  it('保留自然滚动链接，不提供幻灯片式换幕导航', () => {
    const page = renderToStaticMarkup(<App />)
    expect(page).toContain('href="#top"')
    for (const oldControl of ['下一幕', '上一幕', '接着看', 'journey-dots', 'gift-scene']) {
      expect(page).not.toContain(oldControl)
    }
  })

  it('许愿揭晓必须等待主动操作，页面初始没有烟花结尾', () => {
    const page = renderToStaticMarkup(<App />)
    expect(page).toContain(giftCopy.wish.prompt)
    expect(page).not.toContain('class="wish-reveal"')
    expect(page).not.toContain(giftCopy.finale.paragraphs[0])
    expect(page).toContain('role="status"')
  })

  it('默认收起手势玩法，并为照片提供完整查看入口', () => {
    const page = renderToStaticMarkup(<App />)
    expect(page).toContain('id="gift-help" hidden=""')
    expect(page).not.toContain('<video')
    expect(page).toContain('aria-haspopup="dialog"')
    expect(page).toContain('看看完整照片')
  })

  it('摄像头入口默认可见，说明打开页面时会询问一次', () => {
    const page = renderToStaticMarkup(<App />)
    const cameraButton = page.indexOf('开启摄像头')
    const helpPanel = page.indexOf('id="gift-help"')
    expect(cameraButton).toBeGreaterThan(-1)
    expect(cameraButton).toBeLessThan(helpPanel)
    expect(page).toContain('打开页面时会问一次摄像头')
    expect(page).toContain('不会上传，也不会保存')
  })

  it('首页文案只保留全名大标题，右侧照片继续展示', () => {
    const hero = sectionMarkup(renderToStaticMarkup(<App />), 'hero')
    for (const line of giftCopy.hero.title) expect(hero).toContain(line)
    expect(hero).toContain('<img')
    expect(hero).not.toContain('<p')
    expect(hero).not.toContain('<figcaption')
    expect(hero).not.toContain('hero__scroll')
  })

  it('星空和小猪只保留标题及互动，不再显示介绍正文', () => {
    const page = renderToStaticMarkup(<App />)
    const stars = sectionMarkup(page, 'stars')
    const pig = sectionMarkup(page, 'pig')
    expect(stars).toContain(giftCopy.opening.title)
    expect(stars).not.toContain('先别急着往下')
    expect(stars).not.toContain('今天是你的生日，我想把这一小段')
    expect(stars).not.toContain('class="section-prose"')
    expect(pig).toContain(giftCopy.pig.title)
    expect(pig).not.toContain('<p')
    expect(pig).toContain('小猪动画')
  })

  it('祝福正文完整使用用户原话，不再保留旧信件正文', () => {
    const message = '聪明可爱的猪，虽然现在看起来笨笨的，但是不影响你可爱，希望1年后的你已经能站上领奖台或者有不去当牛马的实力，照片我就收藏了'
    const letter = sectionMarkup(renderToStaticMarkup(<App />), 'letter')
    expect(giftCopy.letter.paragraphs).toEqual([message])
    expect(letter).toContain(`<p>${message}</p>`)
    expect(letter.match(/<p(?:\s|>)/g)).toHaveLength(1)
  })

  it('页面所有称呼都使用完整姓名张珂欣', () => {
    const page = renderToStaticMarkup(<App />)
    expect(page).toContain('张珂欣')
    expect(page.replaceAll('张珂欣', '')).not.toContain('珂欣')
  })
})
