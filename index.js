// MAINFRAME

const sharp = require('sharp')
const { parallel } = require('async')
const { log, time, timeEnd } = console
const { join, parse } = require('path')
const { execSync } = require('child_process')
const { read, diff, distance } = require('jimp')

const {
  rmSync,
  statSync,
  mkdirSync,
  existsSync,
  renameSync,
  readdirSync,
} = require('fs')

const DIST = 5
const MIN = 0.2
const EXT = '.png'
const DELIM = '__'
const PRECISION = 5
const TRASH = '_trash'
const THRESHOLD = 0.025
const EXTS = /\.(png|jpe?g)$/i

const joinName = (...parts) => parts.join(DELIM) + EXT
const splitName = file => parse(file).name.split(DELIM)
const zfill = value => value.toString().padStart(PRECISION, '0')
const parseSharp = name => parseFloat(`${name[0]}.${name.slice(1)}`)

const dirs = dir =>
  readdirSync(dir).filter(
    e => statSync(join(dir, e)).isDirectory() && !e.includes('_')
  )

const images = dir =>
  readdirSync(dir)
    .filter(file => EXTS.test(file))
    .map(file => ({ file, created: statSync(join(dir, file)).birthtime }))
    .sort((a, b) => a.created - b.created)
    .map(({ file }) => file)

const mv = (from, to) => renameSync(from, to)
const rm = item => rmSync(item, { recursive: true })
const md = name => !existsSync(name) && mkdirSync(name)
const clean = () => [images, dirs].flatMap(f => f('.')).forEach(rm)

const ungroupDir = (dir, d) => {
  images(join(dir, d)).forEach(f => mv(join(dir, d, f), join(dir, f)))
  rm(join(dir, d))
}

const ungroup = dir => dirs(dir).forEach(d => ungroupDir(dir, d))

const extract = input => {
  log('Extracting...')
  time('extract')
  const { base, name } = parse(input)
  execSync(`ffmpeg -i ${base} -vsync vfr ${name}__%0${PRECISION}d${EXT}`)
  timeEnd('extract')
}

const sort = async dir => {
  log('Sorting...')
  time('sort')
  let ext = EXT
  md(join(dir, TRASH))
  const isDir = dir != '.'
  const imgs = images(dir)
  const len = imgs.length

  await parallel(
    imgs.map((img, i) => async () => {
      const { sharpness } = await sharp(join(dir, img)).stats()
      if (sharpness <= MIN) return mv(join(dir, img), join(dir, TRASH, img))
      let [video, frame] = splitName(img)

      if (isDir) {
        video = dir
        ext = parse(img).ext
        frame = zfill(i + 1)
      }

      const sharpstr = sharpness.toFixed(PRECISION).replace(/\./g, '')
      const newImg = joinName(video, sharpstr, frame)
      log(`${i}/${len} ${img} -> ${newImg}`)
      if (img === newImg) return
      mv(join(dir, img), join(dir, newImg))
    })
  )

  timeEnd('sort')
}

const group = async (dir, threshold) => {
  log('Grouping...')
  time('group')
  let group = 1
  const imgs = images(dir)
  const len = imgs.length
  const groupdir = () => join(dir, zfill(group))
  md(groupdir())
  threshold = parseFloat(threshold ?? THRESHOLD)

  const cmp = async (a, b) => {
    if (!b) return false
    const imgA = await read(join(dir, a))
    const imgB = await read(join(dir, b))
    return (
      distance(imgA, imgB) <= threshold * DIST ||
      diff(imgA, imgB).percent <= threshold
    )
  }

  for (let i = 0; i < len; i++) {
    const img = imgs[i]
    const next = imgs[i + 1]
    const same = await cmp(img, next)
    mv(join(dir, img), join(groupdir(), img))
    log(`${i}/${len} ${group}`)

    if (!same) {
      if (images(groupdir())?.length === 1) ungroupDir(dir, zfill(group))
      group++
      md(groupdir())
    }
  }

  timeEnd('group')
  return Promise.resolve(group)
}

const rank = async (dir = '.') => {
  log('Ranking...')
  time('rank')
  const alldirs = dirs(dir)
  if (dir !== '.') alldirs.unshift(dir)
  const len = alldirs.length

  await parallel(
    alldirs.map((d, i) => async () => {
      const cwd = d === dir
      const root = cwd ? '' : dir
      const imgs = images(join(root, d)).sort().reverse()
      const sharps = imgs.map(img => parseSharp(splitName(img)[1]))
      let avg = sharps.reduce((a, b) => a + b, 0) / sharps.length
      log(`${i}/${len} ${avg.toFixed(PRECISION)} (${imgs.length})`)

      imgs.forEach((f, j) => {
        const best = sharps[j] >= avg
        if (cwd && best) return
        mv(join(root, d, f), join(root, best ? '' : TRASH, f))
      })
      if (!cwd) rm(join(root, d))
    })
  )

  timeEnd('rank')
}

const best = async dir => {
  time('best')
  log('Finding best images...')
  const imgs = images(dir)
  const len = imgs.length
  let max = 0
  const best = []

  for (let i = 0; i < len; i++) {
    const img = imgs[i]
    const { sharpness } = await sharp(img).stats()
    console.log(img, sharpness, max)
    if (Math.abs(sharpness - max) > 0.5) {
      max = sharpness
      best.push(imgs[i - 1], img, imgs[i + 1])
    }
  }
  timeEnd('best')
  log('best', best)
}

const usage = () => log(`
MAINFRAME :: Automatic Frame Extraction

Usage:
  $ mainframe <input> [-<command>]

  <input>:
    video.mp4   The name of a video file to process (mp4,mov,mkv,etc.)
    directory   The name of a directory containing frames/images to process

  -<command>:
    -e          Extracts all frames from input video
    -s          Sorts all frames by sharpness
    -g          Groups all frames by simularity
    -r          Ranks all frames by averaging sharpness and trashes below average

  Utility Commands:
    -u          Ungroups a set of grouped frames without trashing
    -b          Compares sharpness frame by frame keeping only the best frames

`)

async function main() {
  time()
  const [input, cmd, threshold] = process.argv.slice(2)
  if (!input) return usage()
  
  const dir = statSync(input).isDirectory() ? input : '.'
  log('Extract', dir + '...')

  if (!cmd && dir === '.') clean()
  if ((!cmd && dir == '.') || cmd == '-e') extract(input)
  if (!cmd || cmd == '-s') await sort(dir)
  if (!cmd || cmd == '-g') await group(dir, threshold)
  if (!cmd || cmd == '-r') await rank(dir)
  if (cmd == '-u') ungroup(dir)
  if (cmd == '-b') await best(dir)

  timeEnd()
  log('Extract complete')
}

main()
