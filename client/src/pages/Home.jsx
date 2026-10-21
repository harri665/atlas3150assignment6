import { useEffect, useRef, useState } from 'react'
import { mountRelight, preloadRelight } from '../relight/relight.js'
import { notifyDiscord, sendRelightReport } from '../relight/stats.js'

const BASE = import.meta.env.BASE_URL

export default function Home() {
  const roomRef = useRef(null)
  const [note, setNote] = useState('scene setup')

  useEffect(() => {
    preloadRelight()
    const room = mountRelight(roomRef.current, {
      look: { dim: 1, saturation: 1 },
      onReport: (report) => {
        sendRelightReport(report)
        notifyDiscord(report)
      },
      onFail: (error) => {
        setNote(`The live room can’t run in this browser (${error.message}). The picture above shows what it looks like.`)
      },
    })
    return () => room.dispose()
  }, [])

  return (
    <section>
      <img
        src={`${BASE}cornell-box.jpg`}
        width="400"
      />

      <h2>Try it live</h2>
      <p>
        Move your mouse over the room (or drag your finger on a phone) and the light follows you. Watch the red and
        green walls <em>bleed color</em> onto the floor and the block as it moves.
      </p>

      <div className="room" ref={roomRef}></div>
      <p>{note}</p>
    </section>
  )
}
