// What we store in the keychain
export interface Data {
    // Despite the name this is the expiry time of the access token (seconds since the epoch),
    // not a duration. The name is kept so tokens stored by older versions still load.
    expires_in: number;
    access_token: string;
    refresh_token?: string;
}

// What MyAnimeList's token endpoint returns
export interface Response {
    token_type?: string;
    expires_in?: number; // lifetime in seconds
    access_token?: string;
    refresh_token?: string;
}
