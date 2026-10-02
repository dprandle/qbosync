export const OUR_UPDATE_BY = "qbosync";
export type uid = {
    source_str: string;
};

export type change_info = {
    by: uid;
    on: Date;
};

export const INVALID_DATETIME = new Date("0001-01-01T00:00:00.000Z");
export const INVALID_IND = -1;

export function make_ci(by: string, on: Date): change_info {
    return { by: { source_str: by }, on };
}

export function make_ci_now(by_extra: string = ""): change_info {
    return make_ci(OUR_UPDATE_BY + by_extra, new Date());
}

export function make_ci_not_archived(by_extra: string = ""): change_info {
    return make_ci(OUR_UPDATE_BY + by_extra, INVALID_DATETIME);
}

export function changed_by_us(ci: change_info): boolean {
    return ci.by.source_str.includes(OUR_UPDATE_BY);
}

export function is_active(archived_on: Date): boolean {
    return archived_on.getTime() <= INVALID_DATETIME.getTime();
}
