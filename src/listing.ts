import mime from "mime"
import { encodePath } from "./utils"

/** file type bits of a stat mode */
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

export type EntryKind = 'folder' | 'link' | 'file'
export type EntryIcon = 'folder' | 'link' | 'image' | 'video' | 'audio' | 'archive' | 'text' | 'pdf' | 'file'

export interface ListingEntry {
    name: string
    href: string
    kind: EntryKind
    icon: EntryIcon
    /** bytes, null for folders and links */
    size: number | null
    sizeText: string
    /** ISO date, null when the server sent none */
    modified: string | null
    modifiedText: string
}

export interface Breadcrumb {
    name: string
    href: string
}

export interface FolderView {
    title: string
    breadcrumbs: Breadcrumb[]
    parent: string | null
    entries: ListingEntry[]
}

/** what sftp readdir returns for each entry */
export interface DirectoryEntry {
    filename: string
    attrs: { mode?: number, size?: number, mtime?: number }
}

/** names starting with a dot, like .git and .env, often hold what was never meant to be shared */
export const isHiddenName = (name: string) => name.startsWith('.')

/** whether any part of a request path is hidden, `..` and `.` count too */
export const hasHiddenSegment = (requestPath: string) => requestPath.split('/').some(isHiddenName)

const ARCHIVE_TYPES = [
    'application/zip', 'application/gzip', 'application/x-gzip', 'application/x-tar', 'application/x-7z-compressed',
    'application/vnd.rar', 'application/x-rar-compressed', 'application/x-bzip2', 'application/x-xz', 'application/zstd',
    'application/java-archive', 'application/x-apple-diskimage',
]
const TEXT_TYPES = ['application/json', 'application/javascript', 'application/xml', 'application/yaml', 'application/x-sh', 'application/toml']

function fileIcon(name: string): EntryIcon {
    // only the last extension, mime would call .tar.gz plain gzip anyway
    const type = mime.getType(name) ?? ''
    if (type.startsWith('image/')) return 'image'
    if (type.startsWith('video/')) return 'video'
    if (type.startsWith('audio/')) return 'audio'
    if (type === 'application/pdf') return 'pdf'
    if (ARCHIVE_TYPES.includes(type)) return 'archive'
    if (type.startsWith('text/') || TEXT_TYPES.includes(type)) return 'text'
    return 'file'
}

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB']

/** 1023 B, 1.5 KB, 120 MB: one decimal below 10, none above */
export function formatSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    let value = bytes / 1024
    let unit = 0
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024
        unit++
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`
}

/** the page shows this until its script turns it into the visitor's own time zone */
const formatUtc = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** folders first, then by name the way people count: file2 before file10, case does not matter */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** what the folder page shows for `requestPath`, which ends with a slash */
export function folderView(requestPath: string, files: DirectoryEntry[], options: { siteName: string, showHidden: boolean }): FolderView {
    const entries = files
        .filter((file) => file.filename !== '.' && file.filename !== '..')
        .filter((file) => options.showHidden || !isHiddenName(file.filename))
        .map((file): ListingEntry => {
            const type = (file.attrs.mode ?? 0) & S_IFMT
            const kind: EntryKind = type === S_IFDIR ? 'folder' : type === S_IFLNK ? 'link' : 'file'
            const modified = typeof file.attrs.mtime === 'number' ? new Date(file.attrs.mtime * 1000) : null
            const size = kind === 'file' && typeof file.attrs.size === 'number' ? file.attrs.size : null
            return {
                name: file.filename,
                // a folder link without the slash costs a redirect, one more round trip through the tunnel
                href: encodePath(requestPath + file.filename) + (kind === 'folder' ? '/' : ''),
                kind,
                icon: kind === 'file' ? fileIcon(file.filename) : kind,
                size,
                sizeText: size === null ? '' : formatSize(size),
                modified: modified ? modified.toISOString() : null,
                modifiedText: modified ? formatUtc(modified) : '',
            }
        })
        .sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || collator.compare(a.name, b.name))

    const segments = requestPath.split('/').filter(Boolean)
    const breadcrumbs: Breadcrumb[] = [
        { name: options.siteName, href: '/' },
        ...segments.map((name, index) => ({ name, href: encodePath(`/${segments.slice(0, index + 1).join('/')}/`) })),
    ]

    return {
        title: segments.length ? `${segments[segments.length - 1]} · ${options.siteName}` : options.siteName,
        breadcrumbs,
        parent: segments.length ? breadcrumbs[breadcrumbs.length - 2].href : null,
        entries,
    }
}
