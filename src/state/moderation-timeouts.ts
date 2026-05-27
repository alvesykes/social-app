import {useEffect, useRef} from 'react'
import {AtUri} from '@atproto/api'
import {useQueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import * as persisted from '#/state/persisted'
import {
  defaultsModerationTimeouts,
  type ModerationTimeoutRecord,
  type ModerationTimeouts,
} from '#/state/persisted/schema'
import {RQKEY as MY_BLOCKED_RQKEY} from '#/state/queries/my-blocked-accounts'
import {RQKEY as MY_MUTED_RQKEY} from '#/state/queries/my-muted-accounts'
import {RQKEY as PROFILE_RQKEY} from '#/state/queries/profile'
import {useAgent, useSession} from '#/state/session'
import {useTickEveryMinute} from '#/state/shell'

export type ModerationTimeoutKind = 'block' | 'mute'
export type ModerationTimeoutDuration =
  | 'forever'
  | '24_hours'
  | '7_days'
  | '30_days'

const ONE_DAY = 24 * 60 * 60 * 1000

function getTimeouts(): ModerationTimeouts {
  return persisted.get('moderationTimeouts') || defaultsModerationTimeouts
}

function getKindKey(kind: ModerationTimeoutKind) {
  return kind === 'block' ? 'blocks' : 'mutes'
}

function cloneTimeouts(): ModerationTimeouts {
  const timeouts = getTimeouts()
  return {
    blocks: {...timeouts.blocks},
    mutes: {...timeouts.mutes},
  }
}

export function calculateExpiresAt(
  duration: ModerationTimeoutDuration,
  now = Date.now(),
): string | undefined {
  switch (duration) {
    case '24_hours':
      return new Date(now + ONE_DAY).toISOString()
    case '7_days':
      return new Date(now + 7 * ONE_DAY).toISOString()
    case '30_days':
      return new Date(now + 30 * ONE_DAY).toISOString()
    case 'forever':
      return undefined
  }
}

export function isExpired(expiresAt?: string) {
  return Boolean(expiresAt && Date.parse(expiresAt) <= Date.now())
}

export function getModerationTimeoutRecord(
  kind: ModerationTimeoutKind,
  did: string,
) {
  return getTimeouts()[getKindKey(kind)][did]
}

export function shouldKeepModerationEntry(
  kind: ModerationTimeoutKind,
  did: string,
) {
  const record = getModerationTimeoutRecord(kind, did)
  return !record || !isExpired(record.expiresAt)
}

export async function setModerationTimeout(
  kind: ModerationTimeoutKind,
  did: string,
  record?: ModerationTimeoutRecord,
) {
  const next = cloneTimeouts()
  const kindKey = getKindKey(kind)
  if (record) {
    next[kindKey][did] = record
  } else {
    delete next[kindKey][did]
  }
  await persisted.write('moderationTimeouts', next)
}

export function clearModerationTimeout(
  kind: ModerationTimeoutKind,
  did: string,
) {
  return setModerationTimeout(kind, did, undefined)
}

export function useModerationTimeoutCleanup() {
  const tick = useTickEveryMinute()
  const {currentAccount} = useSession()
  const agent = useAgent()
  const queryClient = useQueryClient()
  const isRunning = useRef(false)

  useEffect(() => {
    if (!currentAccount) return
    if (isRunning.current) return

    const timeouts = getTimeouts()
    const expiredBlockEntries = Object.entries(timeouts.blocks).filter(
      ([, record]) => isExpired(record.expiresAt),
    )
    const expiredMuteEntries = Object.entries(timeouts.mutes).filter(
      ([, record]) => isExpired(record.expiresAt),
    )

    if (!expiredBlockEntries.length && !expiredMuteEntries.length) {
      return
    }

    isRunning.current = true

    void (async () => {
      const nextTimeouts = cloneTimeouts()

      try {
        for (const [did, record] of expiredBlockEntries) {
          if (!record.uri) {
            continue
          }

          try {
            const {rkey} = new AtUri(record.uri)
            await agent.app.bsky.graph.block.delete({
              repo: currentAccount.did,
              rkey,
            })
            delete nextTimeouts.blocks[did]
          } catch (e: unknown) {
            logger.error('Failed to clean up expired block timeout', {
              message: e,
            })
          }
        }

        for (const [did] of expiredMuteEntries) {
          try {
            await agent.unmute(did)
            delete nextTimeouts.mutes[did]
          } catch (e: unknown) {
            logger.error('Failed to clean up expired mute timeout', {
              message: e,
            })
          }
        }

        await persisted.write('moderationTimeouts', nextTimeouts)
        void queryClient.invalidateQueries({queryKey: MY_BLOCKED_RQKEY()})
        void queryClient.invalidateQueries({queryKey: MY_MUTED_RQKEY()})

        for (const [did] of [...expiredBlockEntries, ...expiredMuteEntries]) {
          void queryClient.invalidateQueries({queryKey: PROFILE_RQKEY(did)})
        }
      } finally {
        isRunning.current = false
      }
    })()
  }, [agent, currentAccount, queryClient, tick])
}
