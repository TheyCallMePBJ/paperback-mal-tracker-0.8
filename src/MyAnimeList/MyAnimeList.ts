import {
    ContentRating,
    DUIForm,
    PagedResults,
    SearchRequest,
    DUISection,
    DUIFormRow,
    DUIBinding,
    SourceInfo,
    Request,
    Response,
    TrackerActionQueue,
    TrackedMangaChapterReadAction,
    Searchable,
    MangaProgressProviding,
    SourceManga,
    MangaProgress,
    SourceIntents
} from '@paperback/types'

import * as MalUser from './models/mal-user'
import * as MalManga from './models/mal-manga'
import * as MalPage from './models/mal-page'
import * as MalToken from './models/mal-token'
import { MalResult } from './models/mal-result'

import { stringify } from 'querystring'

import {
    getDefaultStatus,
    trackerSettings
} from './MALSettings'

const MYANIMELIST_API = 'https://api.myanimelist.net/v2'
const MAL_CLIENT_ID = 'c537b0a64d24021367b5367414821be2'
const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token'

// The 0.8 app takes plain values for form rows, but its types only allow a DUIBinding
const formValue = (value: unknown): DUIBinding => value as DUIBinding

// Refresh the access token once it has less than this many seconds left
const TOKEN_REFRESH_MARGIN = 24 * 60 * 60
// Used when the expiry can't be read from the token (MAL tokens last 31 days)
const DEFAULT_TOKEN_LIFETIME = 31 * 24 * 60 * 60

// TEMPORARY: shows debug rows in the source menu. Set to false before publishing.
const SHOW_DEBUG_TOOLS = true

export const MyAnimeListInfo: SourceInfo = {
    name: 'MyAnimeList',
    author: 'Netsky',
    contentRating: ContentRating.EVERYONE,
    icon: 'icon.png',
    version: '1.2.0',
    description: 'MyAnimeList Tracker',
    websiteBaseURL: 'https://myanimelist.net',
    intents: SourceIntents.MANGA_TRACKING | SourceIntents.SETTINGS_UI
}

export class MyAnimeList implements Searchable, MangaProgressProviding {
    stateManager = App.createSourceStateManager();

    requestManager = App.createRequestManager({
        requestsPerSecond: 2.5,
        requestTimeout: 20_000,
        interceptor: {
            // Authorization injector
            interceptRequest: async (request: Request): Promise<Request> => {
                let tokenData = await this.tokenData.get()

                if (tokenData != null && this.isTokenExpiring(tokenData)) {
                    console.log('[MAL] Access token is about to expire, refreshing it')
                    await this.refreshAccessToken()
                    // Use the new token for this request, not the one read above
                    tokenData = await this.tokenData.get()
                }

                request.headers = {
                    ...(request.headers ?? {}),
                    ...({
                        'accept': 'application/json'
                    }),
                    ...(tokenData != null ? {
                        'authorization': `Bearer ${tokenData.access_token}`
                    } : {})
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                // 401 means MAL no longer accepts the access token (expired early or revoked).
                // Mark it as expired so the next request refreshes it first.
                if (response.status === 401) {
                    const tokenData = await this.tokenData.get()
                    if (tokenData != null) {
                        await this.tokenData.set({ ...tokenData, expires_in: 0 })
                    }
                }
                return response
            }
        }
    });

    // Only used for the OAuth token endpoint. It has no interceptor, so refreshing the
    // token can't trigger another refresh (the old code looped forever here).
    authRequestManager = App.createRequestManager({
        requestsPerSecond: 1,
        requestTimeout: 20_000
    });

    // Set while a token refresh is running, so concurrent requests share one refresh
    refreshInFlight: Promise<void> | undefined;

    tokenData = {
        get: async (): Promise<MalToken.Data | undefined> => {
            return this.stateManager.keychain.retrieve('token_data') as Promise<MalToken.Data | undefined>
        },
        set: async (tokenData: MalToken.Data | undefined): Promise<void> => {
            await this.stateManager.keychain.store('token_data', tokenData)
        },
        isValid: async (): Promise<boolean> => {
            return (await this.tokenData.get()) != null
        }
    };

    userInfo = {
        get: async (): Promise<MalUser.User | undefined> => {
            return this.stateManager.retrieve('userInfo') as Promise<MalUser.User | undefined>
        },
        isLoggedIn: async (): Promise<boolean> => {
            return (await this.userInfo.get()) != null
        },
        refresh: async (): Promise<void> => {
            const tokenData = await this.tokenData.get()
            if (tokenData == null) {
                return this.stateManager.store('userInfo', undefined)
            }
            const response = await this.requestManager.schedule(App.createRequest({
                url: `${MYANIMELIST_API}/users/@me`,
                method: 'GET'
            }), 0)

            const userInfo = MalResult<MalUser.User>(response)
            await this.stateManager.store('userInfo', userInfo)
        }
    };


    async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
        const pageURL = metadata as string | undefined
        const title = (query.title ?? '').trim()

        // MAL answers queries shorter than 3 characters with HTTP 400
        if (pageURL == null && title.length < 3) {
            return App.createPagedResults({ results: [], metadata: undefined })
        }

        const response = await this.requestManager.schedule(App.createRequest({
            // encodeURIComponent, so titles with & # ? don't cut the query short
            url: pageURL ?? `${MYANIMELIST_API}/manga?q=${encodeURIComponent(title)}&limit=30&nsfw=true`,
            method: 'GET'
        }), 1)

        const malPage = MalResult<MalPage.Results>(response)

        //console.log(JSON.stringify(malPage, null, 2)) // Log request data

        if (!malPage || malPage.data.length == 0) {
            return App.createPagedResults({ results: [], metadata: undefined })
        }

        return App.createPagedResults({
            results: malPage.data?.map(manga => App.createPartialSourceManga({
                image: manga.node.main_picture?.large ?? '',
                title: manga.node.title,
                mangaId: manga.node.id.toString(),
                subtitle: undefined
            })) ?? [],
            metadata: malPage.paging?.next
        })

    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const response = await this.requestManager.schedule(App.createRequest({
            url: encodeURI(`${MYANIMELIST_API}/manga/${parseInt(mangaId)}?fields=id,title,main_picture,alternative_titles,synopsis,mean,rank,popularity,nsfw,media_type,status,my_list_status,num_volumes,num_chapters,authors{first_name,last_name}`),
            method: 'GET'
        }), 1)

        const malManga = MalResult<MalManga.Result>(response)

        //console.log(JSON.stringify(malManga, null, 2)) // Log request data

        if (malManga == null) {
            return Promise.reject()
        }

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                image: malManga.main_picture?.large ?? '',
                titles: [
                    malManga.title,
                    malManga.alternative_titles?.en,
                    malManga.alternative_titles?.ja
                ].filter(x => x != null) as string[],
                artist: this.formatStaffName(malManga.authors?.find(x => x?.role?.toLowerCase().includes('art'))?.node),
                author: this.formatStaffName(malManga.authors?.find(x => x?.role?.toLowerCase().includes('story'))?.node),
                desc: malManga?.synopsis || '',
                hentai: this.formatNSFW(malManga?.nsfw ?? ''),
                rating: malManga.mean,
                status: this.formatStatus(malManga.status)
            })
        })
    }

    async getMangaProgress(mangaId: string): Promise<MangaProgress | undefined> {
        const response = await this.requestManager.schedule(App.createRequest({
            url: encodeURI(`${MYANIMELIST_API}/manga/${parseInt(mangaId)}?fields=my_list_status`),
            method: 'GET'
        }), 1)

        const malManga = MalResult<MalManga.Result>(response)

        //console.log(JSON.stringify(malManga, null, 2)) // Log request data

        if (!malManga?.my_list_status) { return undefined }

        return App.createMangaProgress({
            mangaId: mangaId,

            lastReadChapterNumber: malManga?.my_list_status.num_chapters_read ?? 0,
            lastReadVolumeNumber: malManga?.my_list_status.num_volumes_read,

            trackedListName: malManga?.my_list_status.status ?? undefined,
            userRating: malManga?.my_list_status.score
        })
    }

    async getMangaProgressManagementForm(mangaId: string): Promise<DUIForm> {
        return App.createDUIForm({
            sections: async () => {
                const [response] = await Promise.all([
                    this.requestManager.schedule(App.createRequest({
                        url: encodeURI(`${MYANIMELIST_API}/manga/${parseInt(mangaId)}?fields=id,title,main_picture,alternative_titles,synopsis,mean,rank,popularity,nsfw,media_type,status,my_list_status,num_volumes,num_chapters,authors{first_name,last_name}`),
                        method: 'GET'
                    }), 1),

                    this.userInfo.refresh()
                ])

                const malManga = MalResult<MalManga.Result>(response)

                //console.log(JSON.stringify(malManga, null, 2)) // Log request data

                const user = await this.userInfo.get()
                if (user == null) {
                    return [
                        App.createDUISection({
                            id: 'notLoggedInSection',
                            isHidden: false,
                            rows: async () => [
                                App.createDUILabel({
                                    id: 'notLoggedIn',
                                    label: 'Not Logged In'
                                })
                            ]
                        })
                    ]
                }

                if (malManga == null) {
                    throw new Error(`Unable to find Manga on MyAnimeList with id ${mangaId}`)
                }

                return [
                    App.createDUISection({
                        id: 'userInfo',
                        isHidden: false,
                        rows: async () => [
                            App.createDUIHeader({
                                id: 'header',
                                imageUrl: user.picture || '',
                                title: user.name ?? 'NOT LOGGED IN',
                                subtitle: ''
                            })
                        ]
                    }),
                    // Static items
                    App.createDUISection({
                        id: 'information',
                        header: 'Information',
                        isHidden: false,
                        rows: async () => [
                            App.createDUILabel({
                                id: 'mediaId',
                                label: 'Manga ID',
                                value: malManga.id?.toString()
                            }),
                            App.createDUILabel({
                                id: 'mangaTitle',
                                label: 'Title',
                                value: malManga.title ?? 'N/A'
                            }),
                            App.createDUILabel({
                                id: 'mangaRank',
                                value: malManga.rank?.toString() ?? 'N/A',
                                label: 'Rank'
                            }),
                            App.createDUILabel({
                                id: 'mangaPopularity',
                                value: malManga.popularity?.toString() ?? 'N/A',
                                label: 'Popularity'
                            }),
                            App.createDUILabel({
                                id: 'mangaRating',
                                value: malManga.mean?.toString() ?? 'N/A',
                                label: 'Rating'
                            }),
                            App.createDUILabel({
                                id: 'mangaStatus',
                                value: this.formatStatus(malManga.status),
                                label: 'Status'
                            }),
                            App.createDUILabel({
                                id: 'mangaIsAdult',
                                value: this.formatNSFW(malManga.nsfw ?? '') ? 'Yes' : 'No',
                                label: 'Is Adult'
                            })
                        ]
                    }),
                    // User interactive items
                    // Status
                    App.createDUISection({
                        id: 'trackStatus',
                        header: 'Manga Status',
                        footer: 'Warning: Setting this to NONE will delete the listing from MyAnimeList!',
                        isHidden: false,
                        rows: async () => [
                            App.createDUISelect({
                                id: 'status',
                                value: formValue(malManga.my_list_status?.status ? [malManga.my_list_status.status] : await getDefaultStatus(this.stateManager)),
                                allowsMultiselect: false,
                                label: 'Status',
                                labelResolver: async (value) => {
                                    return this.formatStatus(value)
                                },
                                options: [
                                    'NONE',
                                    'reading',
                                    'plan_to_read',
                                    'completed',
                                    'dropped',
                                    'on_hold'
                                ]
                            })
                        ]
                    }),
                    // Progress
                    App.createDUISection({
                        id: 'manage',
                        header: 'Progress',
                        isHidden: false,
                        rows: async () => [
                            App.createDUIStepper({
                                id: 'num_chapters_read',
                                label: 'Chapter',
                                value: formValue(malManga.my_list_status?.num_chapters_read ?? 0),
                                min: 0,
                                step: 1
                            }),
                            App.createDUIStepper({
                                id: 'num_volumes_read',
                                label: 'Volume',
                                value: formValue(malManga.my_list_status?.num_volumes_read ?? 0),
                                min: 0,
                                step: 1
                            })
                        ]
                    }),
                    // Rating
                    App.createDUISection({
                        id: 'rateSection',
                        header: 'Rating',
                        isHidden: false,
                        rows: async () => [
                            App.createDUIStepper({
                                id: 'score',
                                label: 'Score',
                                value: formValue(malManga.my_list_status?.score ?? 0),
                                min: 0,
                                max: 10,
                                step: 1
                            })
                        ]
                    }),
                    // Re-read
                    App.createDUISection({
                        id: 'mangaReread',
                        header: 'Times Re-read',
                        isHidden: false,
                        rows: async () => [
                            App.createDUIStepper({
                                id: 'num_times_reread',
                                label: 'Re-read Amount',
                                value: formValue(malManga.my_list_status?.num_times_reread ?? 0),
                                min: 0,
                                max: 100,
                                step: 1
                            })
                        ]
                    }),
                    // Notes
                    App.createDUISection({
                        id: 'mangaNotes',
                        header: 'Notes',
                        isHidden: false,
                        rows: async () => [
                            App.createDUIInputField({
                                id: 'notes',
                                label: 'Notes',
                                value: formValue(malManga.my_list_status?.comments ?? '')
                            })
                        ]
                    })
                ]
            },
            onSubmit: async (values) => {
                const status = values['status']?.[0] ?? ''
                let response: Response

                if (status == 'NONE' && mangaId != null) {
                    response = await this.requestManager.schedule(App.createRequest({
                        url: `${MYANIMELIST_API}/manga/${parseInt(mangaId)}/my_list_status`,
                        method: 'DELETE'
                    }), 1)
                    // 404 means the title wasn't on the list in the first place
                    if (response.status === 404) {
                        return
                    }

                } else {
                    response = await this.requestManager.schedule(App.createRequest({
                        url: `${MYANIMELIST_API}/manga/${parseInt(mangaId)}/my_list_status`,
                        method: 'PUT',
                        headers: {
                            'content-type': 'application/x-www-form-urlencoded'
                        },
                        data: stringify({
                            status: status,
                            num_chapters_read: Number(values['num_chapters_read']),
                            num_volumes_read: Number(values['num_volumes_read']),
                            score: Number(values['score']),
                            num_times_reread: Number(values['num_times_reread']),
                            comments: values['notes'] ?? ''
                        })
                    }), 1)
                }

                // Surface failures instead of silently dropping the changes
                if (response.status >= 400) {
                    throw new Error(`MyAnimeList rejected the changes (HTTP ${response.status}): ${response.data ?? ''}`)
                }
            }
        })
    }

    async processChapterReadActionQueue(actionQueue: TrackerActionQueue): Promise<void> {
        const chapterReadActions = await actionQueue.queuedChapterReadActions()
        if (chapterReadActions.length == 0) {
            return
        }

        // Several chapters of one title can be queued; one update per title is enough
        const actionsByManga = new Map<string, TrackedMangaChapterReadAction[]>()
        for (const readAction of chapterReadActions) {
            const actions = actionsByManga.get(readAction.mangaId) ?? []
            actions.push(readAction)
            actionsByManga.set(readAction.mangaId, actions)
        }

        let synced = 0
        const failures: string[] = []

        for (const [mangaId, actions] of actionsByManga) {
            try {
                const response = await this.syncReadProgress(mangaId, actions)

                if (response == null || response.status < 400) {
                    synced++
                    for (const action of actions) {
                        await actionQueue.discardChapterReadAction(action)
                    }
                } else {
                    console.log(`[MAL] Chapter sync failed (${response.status}): ${response.data}`)
                    failures.push(`manga ${mangaId}: HTTP ${response.status} ${response.data ?? ''}`)
                    for (const action of actions) {
                        await actionQueue.retryChapterReadAction(action)
                    }
                }

            } catch (error) {
                console.log(error)
                failures.push(`manga ${mangaId}: ${String(error)}`)
                for (const action of actions) {
                    await actionQueue.retryChapterReadAction(action)
                }
            }
        }

        await this.saveSyncStatus(synced, failures)
    }

    // Updates one title's list entry from the chapters read in Paperback.
    // Returns undefined when MAL is already up to date and nothing was sent.
    async syncReadProgress(mangaId: string, actions: TrackedMangaChapterReadAction[]): Promise<Response | undefined> {
        const chapter = Math.max(...actions.map(action => Math.floor(action.chapterNumber)))
        const volume = Math.max(0, ...actions.map(action => Math.floor(action.volumeNumber || 0)))

        const malManga = MalResult<MalManga.Result>(await this.requestManager.schedule(App.createRequest({
            url: `${MYANIMELIST_API}/manga/${parseInt(mangaId)}?fields=num_chapters,num_volumes,my_list_status`,
            method: 'GET'
        }), 0))
        const current = malManga.my_list_status

        // Never lower progress, e.g. when going back to re-read an earlier chapter
        if (current != null && (current.num_chapters_read ?? 0) >= chapter) {
            return undefined
        }

        const totalChapters = malManga.num_chapters ?? 0
        const params: Record<string, string | number> = {
            num_chapters_read: chapter
        }

        if (totalChapters > 0 && chapter >= totalChapters) {
            // Read the last chapter
            params['status'] = 'completed'
            if (malManga.num_volumes) {
                params['num_volumes_read'] = malManga.num_volumes
            }
        } else {
            // Keep "completed" as it is; anything else (not listed, planned, on hold,
            // dropped) becomes "reading", since a new chapter was just read
            params['status'] = current?.status === 'completed' ? 'completed' : 'reading'
            // Only send the volume when there is one: an empty `num_volumes_read=` gets rejected
            if (volume > (current?.num_volumes_read ?? 0)) {
                params['num_volumes_read'] = volume
            }
        }

        return this.requestManager.schedule(App.createRequest({
            url: `${MYANIMELIST_API}/manga/${parseInt(mangaId)}/my_list_status`,
            method: 'PUT',
            headers: {
                'content-type': 'application/x-www-form-urlencoded'
            },
            data: stringify(params)
        }), 0)
    }

    // Kept so the source menu can show what the last sync did, since the App Store app has no logs
    async saveSyncStatus(synced: number, failures: string[]): Promise<void> {
        let status = `${new Date().toISOString()}: ${synced} synced, ${failures.length} failed`
        if (failures.length > 0) {
            status += `\n${failures[0]}`.slice(0, 300)
        }
        await this.stateManager.store('lastSyncStatus', status)
    }

    async getSourceMenu(): Promise<DUISection> {
        return App.createDUISection({
            id: 'sourceMenu',
            header: 'Source Menu',
            isHidden: false,
            rows: async () => {
                const isLoggedIn = await this.userInfo.isLoggedIn()
                if (isLoggedIn) {
                    return [
                        trackerSettings(this.stateManager),
                        App.createDUILabel({
                            id: 'userInfo',
                            label: 'Logged-in as',
                            value: (await this.userInfo.get())?.name ?? 'ERROR'
                        }),
                        App.createDUIMultilineLabel({
                            id: 'lastSyncStatus',
                            label: 'Last Sync',
                            value: (await this.stateManager.retrieve('lastSyncStatus') as string | undefined) ?? 'Never'
                        }),
                        ...(SHOW_DEBUG_TOOLS ? await this.getDebugRows() : []),
                        App.createDUIButton({
                            id: 'logout',
                            label: 'Logout',
                            onTap: async () => {
                                await this.logout()
                            }
                        })
                    ]
                } else {
                    return [
                        App.createDUIOAuthButton({
                            id: 'malLogin',
                            authorizeEndpoint: 'https://myanimelist.net/v1/oauth2/authorize',
                            clientId: MAL_CLIENT_ID,
                            label: 'Login with MyAnimeList',
                            redirectUri: 'paperback://malAuth',
                            responseType: {
                                type: 'pkce',
                                pkceCodeLength: 64,
                                pkceCodeMethod: 'plain', // MAL only supports plain PKCE
                                formEncodeGrant: true, // MAL's token endpoint only accepts form-encoded bodies
                                tokenEndpoint: MAL_TOKEN_URL
                            },
                            successHandler: async (accessToken: string, refreshToken?: string): Promise<void> => {
                                await this.tokenData.set({
                                    expires_in: this.getTokenExpiry(accessToken),
                                    access_token: accessToken,
                                    refresh_token: refreshToken
                                })
                                await this.userInfo.refresh()
                            }
                        })
                    ]
                }
            }
        })
    }

    // Utility
    formatNSFW(label: string | null): boolean {
        switch (label) {
            case 'white':
                return false
            case 'gray':
                return false
            case 'black':
                return true
            default:
                return false
        }
    }

    formatStaffName(authorNode: MalManga.AuthorNode | undefined): string {
        if (!authorNode) {
            return 'Unknown'
        }

        return `${authorNode.first_name} ${authorNode.last_name}`
    }

    formatStatus(value: string | undefined): string {
        switch (value) {
            case 'reading': return 'Reading'
            case 'plan_to_read': return 'Planned'
            case 'completed': return 'Completed'
            case 'dropped': return 'Dropped'
            case 'on_hold': return 'On-Hold'

            case 'finished': return 'Finished'
            case 'currently_publishing': return 'Releasing'
            case 'not_yet_published': return 'Not Yet Released'

            case 'NONE': return 'None'

            default: return 'N/A'
        }
    }

    // Auth

    isTokenExpiring(tokenData: MalToken.Data): boolean {
        return tokenData.expires_in - TOKEN_REFRESH_MARGIN < Date.now() / 1000
    }

    // When the access token expires, in seconds since the epoch. MAL access tokens are JWTs,
    // so this reads their `exp` claim, falling back to the lifetime MAL reported.
    getTokenExpiry(accessToken: string, lifetime?: number): number {
        try {
            const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64').toString())
            if (typeof payload?.exp === 'number') {
                return payload.exp
            }
        } catch (error) {
            console.log(`[MAL] Couldn't read the token expiry: ${String(error)}`)
        }
        return Math.floor(Date.now() / 1000) + (lifetime ?? DEFAULT_TOKEN_LIFETIME)
    }

    // Several requests can notice the expiring token at the same time; they all wait on one refresh.
    async refreshAccessToken(): Promise<void> {
        if (this.refreshInFlight != null) {
            return this.refreshInFlight
        }
        this.refreshInFlight = this.performTokenRefresh()
        try {
            await this.refreshInFlight
        } finally {
            this.refreshInFlight = undefined
        }
    }

    async performTokenRefresh(): Promise<void> {
        const tokenData = await this.tokenData.get()
        if (tokenData?.refresh_token == null) {
            await this.logout()
            throw new Error('MyAnimeList session expired, please log in again')
        }

        const response = await this.authRequestManager.schedule(App.createRequest({
            url: MAL_TOKEN_URL,
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded'
            },
            // MAL's token endpoint only accepts form-encoded bodies
            data: stringify({
                grant_type: 'refresh_token',
                refresh_token: tokenData.refresh_token,
                client_id: MAL_CLIENT_ID
            })
        }), 0)

        if (response.status === 400 || response.status === 401) {
            // The refresh token itself was rejected (expired or revoked), only a new login helps
            console.log(`[MAL] Token refresh rejected (${response.status}): ${response.data}`)
            await this.logout()
            throw new Error('MyAnimeList session expired, please log in again')
        }

        const newTokenData = MalResult<MalToken.Response>(response)
        if (!newTokenData.access_token) {
            throw new Error('MyAnimeList returned no access token while refreshing')
        }

        await this.tokenData.set({
            expires_in: this.getTokenExpiry(newTokenData.access_token, newTokenData.expires_in),
            access_token: newTokenData.access_token,
            refresh_token: newTokenData.refresh_token ?? tokenData.refresh_token
        })
        console.log('[MAL] Access token refreshed')
    }

    async logout(): Promise<void> {
        await this.tokenData.set(undefined)
        await this.stateManager.store('userInfo', undefined)
    }

    // TEMPORARY debug rows, see SHOW_DEBUG_TOOLS
    async getDebugRows(): Promise<DUIFormRow[]> {
        const tokenData = await this.tokenData.get()
        return [
            App.createDUILabel({
                id: 'debugTokenExpiry',
                label: 'Debug: Token expires',
                value: tokenData ? new Date(tokenData.expires_in * 1000).toISOString() : 'No token'
            }),
            App.createDUIButton({
                id: 'debugExpireToken',
                label: 'Debug: Mark token expired',
                onTap: async () => {
                    const current = await this.tokenData.get()
                    if (current != null) {
                        await this.tokenData.set({ ...current, expires_in: 0 })
                    }
                }
            }),
            App.createDUIButton({
                id: 'debugRefreshToken',
                label: 'Debug: Refresh token now',
                onTap: async () => {
                    try {
                        await this.refreshAccessToken()
                        await this.stateManager.store('lastSyncStatus', `${new Date().toISOString()}: debug refresh OK`)
                    } catch (error) {
                        await this.stateManager.store('lastSyncStatus', `${new Date().toISOString()}: debug refresh FAILED: ${String(error)}`)
                    }
                }
            })
        ]
    }
}
