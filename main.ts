//jshint asi: true
//jshint esversion: 11

import { promises as fs } from 'fs'
import { Telegraf, Markup, Context } from 'telegraf'
import fetch from 'node-fetch'
import * as cheerio from 'cheerio'

// Позволяет беспалевно заменить Set'ы Array'ями,
// потому что первые теряются при чтении/записи из/в JSON
class Set<T> extends Array<T> {}
declare global {
    interface Array<T> {
        add(value: T): Array<T>
        has(value: T): boolean
        delete(value: T): boolean
        clear(): undefined
    }
}
Array.prototype.add = function<T>(value: T): T[] {
    if(!this.has(value)){
        this.push(value)
    }
    return this
}
Array.prototype.has = function<T>(value: T): boolean {
    return this.indexOf(value) != -1
}
Array.prototype.delete = function<T>(value: T): boolean {
    const index = this.indexOf(value)
    if (index === -1){
        return false
    }
    this.splice(index, 1)
    return true
}
Array.prototype.clear = function(): undefined {
    this.splice(0, this.length)
    return undefined
}

declare global {
    interface String {
        hash(): string
    }
}
String.prototype.hash = function(){
    let hash = 0
    for(let i = 0; i < this.length; i++){
        hash = (((hash << 5) - hash) + this.charCodeAt(i)) | 0
    }
    return hash.toString(36)
}


class DB {
    subscriptions: { [chatId: number]: Set<string> } = {}
    tree: TreeNodeFolder = new TreeNodeFolder('', [])
}

class TreeNode {
    id: string = '0'
    name: string = ''
    parent: TreeNodeFolder|undefined
    path: string = ''
    constructor(name: string){
        this.name = name
    }
    static is(obj: any): boolean {
        return 'name' in obj
            //&& 'id' in obj
            //&& 'parent' in obj
            //&& 'path' in obj
    }
}
type TreeNodeFolderOrFile = TreeNodeFolder|TreeNodeFile
class TreeNodeFolder extends TreeNode {
    children: TreeNodeFolderOrFile[]
    constructor(name: string, children: TreeNodeFolderOrFile[]){
        super(name)
        this.children = children
    }
    static is(obj: any): obj is TreeNodeFolder {
        return TreeNode.is(obj)
            && 'children' in obj
    }
}

class TreeNodeFile extends TreeNode {
    url: string
    subscribers: Set<number> = new Set()
    constructor(name: string, url: string){
        super(name)
        this.url = url
    }
    static is(obj: any): obj is TreeNodeFile {
        return TreeNode.is(obj)
            && 'url' in obj
    }
}

let db: DB
try {
    db = JSON.parse(await fs.readFile('save.json', 'utf8'))
} catch(e){
    console.error(e)
    db = new DB()
}

const forEach = (node: TreeNodeFolderOrFile, func: (node: TreeNodeFolderOrFile, parent?: TreeNodeFolder) => void, parent?: TreeNodeFolder) => {
    func(node, parent)
    if(TreeNodeFolder.is(node)){
        for(let child of node.children){
            forEach(child, func, node)
        }
    }
}
const restore = (tree: TreeNodeFolder) => forEach(tree, (node, parent) => {
    if(parent){
        node.parent = parent
        node.path = parent.path + '\n' + node.name
        node.id = node.path.hash()
    } else {
        node.id = '0'
        node.path = ''
        node.parent = undefined
    }
})

//TODO: arr2dict<T, K>(...): { [key: K]: T }
function arr2dict<T>(arr: T[], func: (obj: T) => (string | number)): { [key: (string | number)]: T } {
    return Object.fromEntries(arr.map(obj => [ func(obj), obj ]))
}

//TODO: filter: (node) => bool ?
const flat = (root: TreeNodeFolder, out: TreeNodeFolderOrFile[] = []) => {
    forEach(root, (node) => out.push(node))
    return out
}

function filterFiles(flatTree: TreeNodeFolderOrFile[]){
    return flatTree.filter(node => TreeNodeFile.is(node)) as TreeNodeFile[]
}

const cleanup = (node: TreeNodeFolderOrFile): boolean => {
    if(TreeNodeFolder.is(node)){
        node.children = node.children.filter(cleanup)
        return node.children.length > 0
    }
    return true
}

let subscriptions = db.subscriptions
let tree: TreeNodeFolder = db.tree
restore(tree)
let flatTree = flat(tree)
let filesByID = arr2dict<TreeNodeFile>(filterFiles(flatTree), (file) => file.id)
let indexByID = arr2dict(flatTree, node => node.id)

const token = process.env.BOT_TOKEN
const devchat = 0
const bot = new Telegraf(token)

const broadcast = async(cids: Set<string|number>, msg: string, extra = {}) => {
    for(const cid of cids){
        await bot.telegram.sendMessage(cid, msg, extra)
    }
}

type SimpleObj = { [key: number|string]: number|string }
const enc_data = (params: SimpleObj): string =>
    Object.entries(params).map(([key, value]) => key + '=' + value).join('&')
const dec_data = (query: string): SimpleObj =>
    Object.fromEntries(query.split('&').map(kv => kv.split('=').map(v => +v || v)))

const hasFlags = (e: number|undefined, flags: number) => (e! & flags) == flags

enum MenuBtnFlags {
    dontDelete = 1 << 0,
    singleToggle = 1 << 1,
    checked = 1 << 2
}
type MenuParams = {
    id: string,
    flags: MenuBtnFlags
}
const menu_cb_btn = (msg: string, params: MenuParams) =>
    Markup.button.callback(msg, 'new?' + enc_data(params))

const openMenuButton = () =>
    menu_cb_btn('Выбрать другой файл', { id: tree.id, flags: MenuBtnFlags.dontDelete })
const toggleFileButton = (fid: string, checked: boolean) =>
    menu_cb_btn(
        checked ? 'Отслеживается 👁️' : 'Следить за ним',
        { id: fid, flags: MenuBtnFlags.singleToggle | (checked ? MenuBtnFlags.checked : 0) }
    )

const esc = (msg: string) => msg.replace(/([\_\*\[\]\(\)\~\`\>\#\+\-\=\|\{\}\.\!])/g, '\\$1')

const extra = {
    parse_mode: 'MarkdownV2'
}
const broadcastModified = async (file: TreeNodeFile) => {
    await broadcast(file.subscribers, `*Изменился файл*\n` + esc(file.path), {
        ...Markup.inlineKeyboard([
            [ Markup.button.url('Скачать с сайта', 'https://www.sevsu.ru' + file.url) ]
        ]),
        ...extra
    })
}
const broadcastRemoved = async (file: TreeNodeFile) => {
    await broadcast(
        file.subscribers,
        `*Файл был удалён, выберите другой, чтобы снова получать уведомления*\n` + esc(file.path),
        {
            ...Markup.inlineKeyboard([[
               openMenuButton()
            ]]),
            ...extra
        }
    )
}
const broadcastAdded = async (file: TreeNodeFile) => {
    await broadcast(Object.keys(subscriptions), `*Был добавлен новый файл*\n` + esc(file.path), {
        ...Markup.inlineKeyboard([[
            toggleFileButton(file.id, false)
        ]]),
        ...extra
    })
}

const parseFolder = (el: cheerio.Cheerio<cheerio.Element>, parseFunc: (i: number, el: cheerio.Element) => TreeNodeFolderOrFile) : TreeNodeFolder => {
    let first = el.children().first()
    let folder = new TreeNodeFolder(
        first.text().trim(),
        first.next().children().map(parseFunc).toArray()
    )
    return folder
}
const parseFile = (el: cheerio.Cheerio<cheerio.Element>) : TreeNodeFile => {
    return new TreeNodeFile(
        el.text().trim(),
        el.attr('href')?.trim() ?? ''
    )
}
const checkForUpdates = async () => {
    console.log('checking...')

    const response = await fetch('https://www.sevsu.ru/univers/shedule/')
    const body = await response.text()
    
    const $ = cheerio.load(body)
    const root = $('.schedule-table')
    let new_tree =
    parseFolder(root, (i, el) =>
        parseFolder($(el), (i, el) =>
            parseFolder($(el), (i, el) => {
                    let children = $(el).children()
                    let folder = new TreeNodeFolder(
                        children.first().text().trim(),
                        children.slice(1).map((i, el) => {
                            return parseFile($(el))
                        }).toArray()
                    )
                    return folder
                }
            )
        )
    )
    cleanup(new_tree)
    restore(new_tree)

    let new_flatTree = flat(new_tree)
    let new_filesByID = arr2dict<TreeNodeFile>(filterFiles(new_flatTree), (file) => file.id)
    let new_indexByID = arr2dict(new_flatTree, node => node.id)

    let modified: TreeNodeFile[] = []
    let removed: TreeNodeFile[] = []
    let added: TreeNodeFile[] = []

    for(let [id, file] of Object.entries(filesByID)){
        let new_file = new_filesByID[id]
        if(new_file){
            new_file.subscribers = file.subscribers
            if(new_file.url != file.url){
                modified.push(new_file)
            }
        } else {
            for(let cid of file.subscribers){
                subscriptions[cid].delete(file.id)
            }
            removed.push(file)
        }
    }
    for(let [new_id, new_file] of Object.entries(new_filesByID)){
        if(!(new_id in filesByID)){
            added.push(new_file)
        }
    }

    tree = new_tree
    flatTree = new_flatTree
    filesByID = new_filesByID
    indexByID = new_indexByID

    for(let file of modified){
        await broadcastModified(file)
    }
    for(let file of removed){
        await broadcastRemoved(file)
    }
    for(let file of added){
        await broadcastAdded(file)
    }
    console.log(`added: ${added.length}, removed: ${removed.length}, modified: ${modified.length}`)
}

const getsub = (cid: number) => subscriptions[cid] || (subscriptions[cid] = new Set())

let menu = async (ctx: Context & { match?: RegExpMatchArray }) => {
    let m = ctx.match
    let p: undefined | MenuParams
    if(m && m[1]){
        p = dec_data(m[1]) as MenuParams
    }
    let id = p?.id || '0'
    let singleToggle = hasFlags(p?.flags, MenuBtnFlags.singleToggle) // added message
    let dontDelete = hasFlags(p?.flags, MenuBtnFlags.dontDelete) // removed message
    let checked = hasFlags(p?.flags, MenuBtnFlags.checked)
    let cid = ctx.chat!.id //TODO: fix!
    let node = indexByID[id]
    if(!node){
        if(singleToggle){
            await ctx.answerCbQuery('Файл не найден ❌')
            await close_menu(ctx)
            return
        }
        node = tree
    }
    let folder
    let queryAnswered = false
    let subscribed = false
    if(TreeNodeFile.is(node)){
        let file = node
        folder = file.parent! //TODO: fix!
        let sset = getsub(cid)
        subscribed = sset.has(id)
        if(subscribed != checked){
            if(subscribed){
                await ctx.answerCbQuery('Вы уже подписались ❌')
            } else {
                await ctx.answerCbQuery('Вы уже отписались ❌')
            }
        } else {
            if(subscribed){
                sset.delete(id)
                file.subscribers.delete(cid)
                console.log(cid, 'unsubscribed from', id)
                await ctx.answerCbQuery('Вы отписались ✔️')
                subscribed = false
                checked = false
            } else {
                sset.add(id)
                file.subscribers.add(cid)
                console.log(cid, 'subscribed to', id)
                await ctx.answerCbQuery('Вы подписались ✔️')
                subscribed = true
                checked = true
            }
        }
        queryAnswered = true
    } else {
        folder = node
        singleToggle = false
    }
    let buttons
    if(singleToggle){
        buttons = [[
            toggleFileButton(node.id, subscribed)
        ]]
    } else {
        buttons = []
        let flags = (dontDelete ? MenuBtnFlags.dontDelete : 0)
        for(let child of folder.children){
            let icon = ''
            checked = false
            if(TreeNodeFile.is(child)){
                if(child.subscribers.has(cid)){
                    icon = '🟢 '
                    checked = true
                }
            } else {
                //TODO: optimize. forEach(..., { break: false }) ?
                try {
                    forEach(child, (node) => {
                        if(TreeNodeFile.is(node) && node.subscribers.has(cid)){
                            throw true
                        }
                    })
                } catch(e){
                    if(e === true){
                        icon = '🔵 '
                    } else {
                        throw e
                    }
                }
            }
            buttons.push([
                menu_cb_btn(icon + child.name, {
                    id: child.id,
                    flags: flags | (checked ? MenuBtnFlags.checked : 0)
                })
            ])
        }
        if(folder.parent){ // if not root folder
            buttons.push([
                menu_cb_btn('< Назад >', { id: folder.parent.id, flags })
            ])
        }
        buttons.push([
            Markup.button.callback('> Закрыть <', dontDelete ? 'close' : 'delete')
        ])
    }
    let keyboard = Markup.inlineKeyboard(buttons)
    if(m){
        if(!queryAnswered){
            await ctx.answerCbQuery()
        }
        await ctx.editMessageReplyMarkup(keyboard.reply_markup)
    } else {
        await ctx.sendMessage('Выберите файл:', keyboard)
    }
}
bot.start(menu)
bot.action(/^new\?(.*)/, menu)
bot.action('delete', async (ctx) => {
    await ctx.deleteMessage()
})
const close_menu = async (ctx: Context) => {
    await ctx.editMessageReplyMarkup({
        inline_keyboard: [[ openMenuButton() ]]
    })
}
bot.action('close', close_menu)
bot.command('menu', menu)

bot.command('stats', async (ctx) => {
    let cid = ctx.chat.id
    console.log(cid, 'запросил статус')
    await ctx.sendMessage('Статус: жив\nПодписалось: ' + Object.keys(subscriptions).length)
})
bot.command('debug', async (ctx) => {
    if(ctx.chat.id === devchat){
        let file = Object.values(filesByID)[0]
        await broadcastAdded(file)
        await broadcastModified(file)
        await broadcastRemoved(file)
    }
})

bot.command('resub', async (ctx) => {
    if(ctx.chat.id === devchat){
        for(let cid of [ devchat ]){
            let id = '-ltaa3r'
            let file = filesByID[id]
            let sset = getsub(cid)
            sset.add(id)
            file.subscribers.add(cid)
        }
        await ctx.sendMessage('Пятеро переподписаны');
    }
})

bot.command('suball', async (ctx) => {
    let cid = ctx.chat.id
    let sset = getsub(cid)
    for(let [id, file] of Object.entries(filesByID)){
        sset.add(id)
        file.subscribers.add(cid)
    }
    await ctx.sendMessage('Вы подписались на все файлы');
})
bot.command('unsuball', async (ctx) => {
    let cid = ctx.chat.id
    let sset = getsub(cid)
    for(let id of sset){
        let file = filesByID[id]
        file.subscribers.delete(cid)
    }
    sset.clear()
    await ctx.sendMessage('Вы отписались от всех файлов');
})
bot.command('help', async (ctx) => {
    await ctx.sendMessage('/menu - управление слежением\n/stats - бот, ты как?')
})

const stop = async (reason: string) => {
    clearInterval(checkInterval)
    bot.stop(reason)
    forEach(tree, (node, _) => {
        //delete (node as any).id
        delete (node as any).path
        delete node.parent
    })
    await fs.writeFile('save.json', JSON.stringify({ subscriptions, tree }), 'utf8')
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))

bot.launch()
let checkInterval = setInterval(checkForUpdates, 1000 * 60 * 60 * 1)
//checkForUpdates()
console.log('запущен')