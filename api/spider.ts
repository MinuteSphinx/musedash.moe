/* eslint camelcase: ["off"] */
import got = require('got')

const INTERVAL = 1000 * 60 * 60 * 24

const wait = (ms: number): Promise<undefined> => new Promise(resolve => setTimeout(resolve, ms))

const platforms = {
  mobile: 'leaderboard',
  pc: 'pcleaderboard'
}

const download = async ({ api, uid, difficulty }) => (await got(`https://prpr-muse-dash.leanapp.cn/musedash/v1/${api}/top?music_uid=${uid}&music_difficulty=${difficulty + 1}&limit=1999`, { json: true, timeout: 1000 * 60 * 10 })).body.result

const prepare = music => music
  .flatMap(({ uid, difficulty, name }) => difficulty
    .map((difficultyNum, difficulty) => ({ uid, level: difficultyNum, difficulty, name })))
  .flatMap(({ uid, difficulty, name, level }) => Object.entries(platforms)
    .map(([platform, api]) => ({ uid, difficulty, name, level, platform, api })))
  .filter(({ level }) => level)

const round = async ({ pending, rank }: { pending: Array<any>, rank: any }) => {
  for (; pending.length;) {
    const { uid, difficulty, name, platform, api } = pending.shift()
    let result = await download({ uid, difficulty, api }).catch(() => undefined)
    if (!result) {
      pending.unshift({ uid, difficulty, name, platform, api })
      console.log(`RETRY: ${uid}: ${name} - ${difficulty} - ${platform}`)
      continue
    }

    result = result.filter(({ play, user }) => play && user)

    const currentRank = await rank.get({ uid, difficulty, platform })
    if (currentRank) {
      const currentUidRank = currentRank.map(({ play }) => play.user_id)
      for (let i = 0; i < result.length; i++) {
        result[i].history = { lastRank: currentUidRank.indexOf(result[i].play.user_id) }
      }
    }

    await rank.put({ uid, difficulty, platform, value: result })

    console.log(`${uid}: ${name} - ${difficulty} - ${platform} / ${pending.length}`)
  }
}

const analyze = ({ musicList, rank, player }) => [...musicList]
  .reduce(async (p, m) => {
    await p
    const { uid, difficulty, platform } = m
    const currentRank = await rank.get({ uid, difficulty, platform })
    const sumRank = await rank.get({ uid, difficulty, platform: 'all' })
    return (await currentRank
      .map(async ({ user, play: { score, acc }, history }, i) => {
        let playerData = await player.get(user.user_id).catch(() => ({ plays: [] }))
        playerData.user = user
        const sum = sumRank.findIndex(play => play.platform === platform && play.user.user_id === user.user_id)
        playerData.plays.push({ score, acc, i, platform, history, difficulty, uid, sum })
        return { key: user.user_id, value: playerData }
      })
      .reduce(async (b, v) => {
        const { key, value } = await v
        const batch = await b
        return batch.put(key, value)
      }, player.batch()))
      .write()
  }, player.clear())

const sumRank = async ({ musicList, rank }) => (await musicList
  .filter(({ platform }) => platform === 'mobile')
  .map(async ({ uid, difficulty }) => {
    let [currentRank, result] = [await rank.get({ uid, difficulty, platform: 'all' }), (await Promise.all(Object.keys(platforms).map(async platform => (await rank.get({ uid, difficulty, platform })).map(play => ({ ...play, platform })))))
      .flat()
      .sort((a, b) => b.play.score - a.play.score)]
    if (currentRank) {
      for (let i = 0; i < result.length; i++) {
        result[i].history = { lastRank: currentRank.findIndex(play => play.platform === result[i].platform && play.user.user_id === result[i].user.user_id) }
      }
    }
    return { uid, difficulty, platform: 'all', value: result }
  })
  .reduce(async (b, v) => (await b).put(await v), rank.batch()))
  .write()

const makeSearch = ({ player, search }) => new Promise(async resolve => {
  await search.clear()
  console.log('Search cleared')
  const batch = search.batch()
  const stream = player.createValueStream()
  stream.on('data', ({ user: { nickname, user_id } }) => {
    batch.put(user_id, nickname)
  })
  stream.on('close', () => resolve(batch.write()))
})

export default async ({ music, rank, player, PARALLEL, search }: { music, rank: {}, player, PARALLEL: number, search }) => {
  for (; ;) {
    const startTime = Date.now()
    const musicList = prepare(music)
    await Promise.all(Array(PARALLEL).fill([...musicList]).map(pending => round({ pending, rank })))
    await sumRank({ musicList, rank })
    console.log('Ranked')
    await analyze({ musicList, rank, player })
    console.log('Analyzed')
    await makeSearch({ player, search })
    console.log('Search Cached')
    const endTime = Date.now()
    console.log(`Wait ${INTERVAL - (endTime - startTime)}`)
    await wait(INTERVAL - (endTime - startTime))
  }
}
