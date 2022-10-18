//jshint asi: true
//jshint esversion: 11

import * as fs from 'fs'
import { Telegraf, Markup, Context } from 'telegraf'
import fetch from 'node-fetch'
import { Cheerio, Element, load as load_html } from 'cheerio'
import { pipeline } from 'stream/promises'
import mime from 'mime-types'
import * as xlsx from 'xlsx';
xlsx.set_fs(fs)

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

class User {
    chatID: number
    subscriptions: Set<string> = new Set()
    constructor(chatID: number){
        this.chatID = chatID
    }
}

class TreeNode {
    readonly id: string = '0'
    readonly path: string = ''
    readonly name: string
    readonly parent?: TreeNode
    
    children: TreeNode[] = []
    subscribers: Set<User> = new Set()

    constructor(name: string, parent: TreeNode|undefined){
        this.name = name
        if(parent){
            this.parent = parent
            this.path = parent.path + '\n' + name
            this.id = this.path.hash()
        }
    }

    hasSubscriber(user: User){
        if(this.subscribers.has(user)){
            return true
        }
        for(let child of this.children){
            if(child.hasSubscriber(user)){
                return true
            }
        }
        return false
    }

    getSubscribers(out?: Set<User>){
        if(!out){
            out = new Set()
            for(let t = this.parent; t; t = t.parent){
                for(let sub of t.subscribers){
                    out.add(sub)
                }
            }
        }
        for(let sub of this.subscribers){
            out.add(sub)
        }
        for(let child of this.children){
            child.getSubscribers(out)
        }
        return out
    }

    buildIndex(out: any = {}){
        out[this.id] = this
        for(let child of this.children){
            child.buildIndex(out)
        }
        return out
    }
}

class TreeNodeFolder extends TreeNode {
    type: 'folder' = 'folder'

    parent?: TreeNodeFolder
    children: TreeNodeFolderOrFile[] = []
    constructor(name: string, parent?: TreeNodeFolder){
        super(name, parent)
        this.parent = parent
    }
    static is(obj: any): obj is TreeNodeFolder {
        return obj.type == 'folder'
    }
    async download(justCheck = false) {
        for(let child of this.children){
            await child.download(justCheck)
        }
    }
}

class TreeNodeFile extends TreeNode {
    type: 'file' = 'file'

    parent: TreeNodeFolder
    url: string
    saves: string[] = []
    children: TreeNodeRange[] = []
    constructor(name: string, parent: TreeNodeFolder, url: string){
        super(name, parent)
        this.parent = parent
        this.url = url
    }
    static is(obj: any): obj is TreeNodeFile {
        return obj.type == 'file'
    }
    getSavePath(){
        return ('downloads/' + this.path.split('\n').join('/')).replaceAll('//', '/')
    }
    supportsRanges(){
        return this.saves.length > 0 && this.saves.at(-1)!.endsWith('.xlsx')
    }
    async download(justCheck = false) {
        if(justCheck){
            let path = this.getSavePath()
            this.saves = this.saves.filter(file => {
                let fullPath = path + '/' + file
                let ret = fs.existsSync(fullPath)
                if(!ret){
                    console.log(`404 ${fullPath}`)
                }
                return ret
            })
            if(this.saves.length > 0){
                return
            }
        }
        try {
            console.log(`downloading ${this.id} (${this.path.split('\n').join(' -> ')})`)
            const response = await fetch('https://www.sevsu.ru' + this.url)
            if (response.ok){
                const type = response.headers.get('Content-Type')
                const ext = type ? ('.' + mime.extension(type)) : ''
                if(response.body != null){
                    let filename = Date.now().toString() + ext
                    let path = this.getSavePath()
                    await fs.promises.mkdir(path, { recursive: true })
                    await pipeline(response.body, fs.createWriteStream(path + '/' + filename))
                    this.saves.push(filename)
                } else {
                    console.log(`response.body is null while downloading the file ${this.id}`)
                }
            } else {
                console.log(`unexpected response ${response.statusText} while downloading the file ${this.id}`)
            }
            console.log(`downloaded ${this.id}`)
        } catch(e) {
            console.log(`exception occurred while downloading the file ${this.id}\n`, e)
        }
    }
    async compare(){
        let updates = new Map<TreeNodeRange, RangeUpdate>()
        let getUpdate = (range: TreeNodeRange) => {
            let update = updates.get(range)
            if(!update){
                update = new RangeUpdate()
                updates.set(range, update)
            }
            return update
        }
        let first = this.saves[this.saves.length - 2]
        let second = this.saves.at(-1)
        if(first && second && first.endsWith('.xlsx') && second.endsWith('.xlsx')){
            let savePath = this.getSavePath()
            let wb1 = xlsx.readFile(savePath + '/' + first)
            let wb2 = xlsx.readFile(savePath + '/' + second)
            for(let [sheetName, ws2] of Object.entries(wb2.Sheets)){
                let ws1 = wb1.Sheets[sheetName]
                if(ws1){
                    let ws1range = xlsx.utils.decode_range(ws1['!ref']!)
                    let ws2range = xlsx.utils.decode_range(ws2['!ref']!)
                    let maxBBox: xlsx.Range = {
                        s: {r: Math.min(ws1range.s.r, ws2range.s.r),
                            c: Math.min(ws1range.s.c, ws2range.s.c)},
                        e: {r: Math.max(ws1range.e.r, ws2range.e.r),
                            c: Math.min(ws1range.e.c, ws2range.e.c)},
                    }
                    for(let range of this.children){
                        let bbox: xlsx.Range = {
                            s: {r: Math.max(range.range.s.r, maxBBox.s.r),
                                c: Math.max(range.range.s.c, maxBBox.s.c)},
                            e: {r: Math.min(range.range.e.r, maxBBox.e.r),
                                c: Math.min(range.range.e.c, maxBBox.e.c)},
                        }
                        loop:
                        for(let r = bbox.s.r; r <= bbox.e.r; r++){
                            for(let c = bbox.s.c; c <= bbox.e.c; c++){
                                let addr = xlsx.utils.encode_cell({r, c})
                                let c1: xlsx.CellObject = ws1[addr]
                                let c2: xlsx.CellObject = ws2[addr]
                                if((!c1 && !c2) || (c1 && c2 && c1.v == c2.v)){
                                    // pass
                                } else {
                                    let update = getUpdate(range)
                                    update.modified.push(sheetName)
                                    break loop;
                                }
                            }
                        }
                    }
                } else {
                    for(let range of this.children){
                        let update = getUpdate(range)
                        update.added.push({ sheetName })
                    }
                }
            }
        }
        return updates
    }
}

class RangeUpdate {
    modified: string[] = []
    added: { sheetName: string, sameAs?: string }[] = []
}

class TreeNodeRange extends TreeNode {
    type: 'range' = 'range'

    parent: TreeNodeFile
    range: xlsx.Range
    alias: string
    constructor(name: string, parent: TreeNodeFile, range: xlsx.Range, alias?: string){
        super(name, parent)
        this.parent = parent
        this.range = range
        this.alias = alias || name
    }
    static is(obj: any): obj is TreeNodeRange {
        return obj.type == 'range'
    }
}

type TreeNodeFolderOrFile = TreeNodeFolder | TreeNodeFile
type TreeNodeFolderOrFileOrRange = TreeNodeFolder | TreeNodeFile | TreeNodeRange

type Primitive = number | string | boolean | null | undefined | symbol
type Ref = { ref: number }
type FlatObj = {
    $type: string,
    [key:string]: Primitive|Ref
} | (Primitive|Ref)[] | {
    $type: 'Set',
    $values: (Primitive|Ref)[]
}

function save(obj: any){
    let mem: FlatObj[] = []
    flat(obj, mem)
    return mem
}
function flat(
    obj: any,
    mem: FlatObj[],
    map: Map<object, number> = new Map()
): Primitive|Ref {
    if(typeof obj === 'object'){
        let ref = map.get(obj)
        if(ref !== undefined){
            return { ref }
        }

        ref = mem.push(undefined as any) - 1
        map.set(obj, ref)

        let newObj: any
        if(Array.isArray(obj)){
            newObj = []
            for(let value of obj){
                newObj.push(flat(value, mem, map))
            }
        } else if(obj instanceof Set){
            newObj = {
                $type: 'Set',
                $values: []
            }
            for(let value of obj){
                newObj.$values.push(flat(value, mem, map))
            }
        } else {
            newObj = {
                $type: '' + Object.getPrototypeOf(obj)?.constructor.name
            }
            for(let [key, value] of Object.entries(obj)){
                newObj[key] = flat(value, mem, map)
            }
        }
        mem[ref] = newObj
        return { ref }
    } else {
        return obj
    }
}

let prototypes: {
    [key: string]: object|null
} = {
    'null': null,
    'User': User.prototype,
    'TreeNodeFolder': TreeNodeFolder.prototype,
    'TreeNodeFile': TreeNodeFile.prototype,
    'TreeNodeRange': TreeNodeRange.prototype,
}
function load(mem: FlatObj[]){
    let rmem: any[] = []
    for(let obj of mem){
        let newObj: any
        if(Array.isArray(obj)){
            newObj = []
        } else {
            let type = obj.$type
            if(type === 'Set'){
                newObj = new Set()
            } else {
                if(type in prototypes){
                    let proto = prototypes[type]
                    newObj = Object.create(proto)
                } else {
                    newObj = {}
                }
            }
        }
        rmem.push(newObj)
    }
    const unref = (obj: any) => {
        if(typeof obj === 'object' && typeof obj.ref === 'number'){
            return rmem[obj.ref] 
        }
        return obj
    }
    for(let i = 0; i < mem.length; i++){
        let obj = mem[i]
        let newObj = rmem[i]
        if(Array.isArray(obj)){
            for(let value of obj){
                newObj.push(unref(value))
            }
        } else {
            let type = obj.$type
            if(type === 'Set' && Array.isArray(obj.$values)){
                for(let value of obj.$values){
                    newObj.add(unref(value))
                }
            } else {
                for(let [key, value] of Object.entries(obj)){
                    if(!key.startsWith('$')){
                        newObj[key] = unref(value)
                    }
                }
            }
        }
    }
    return rmem[0]
}

let users: {
    [chatID: number]: User
}
let tree: TreeNodeFolder

try {
    let db = load(JSON.parse(await fs.promises.readFile('db.json', 'utf8')))
    users = db.users
    tree = db.tree
} catch(e) {
    console.error(e)
    users = {}
    tree = new TreeNodeFolder('')
}

let treeIndex: {
    [nodeID: string]: TreeNodeFolderOrFileOrRange
} = tree.buildIndex()

const token = process.env.BOT_TOKEN
const bot = new Telegraf(token)

async function broadcast(users: Iterable<User>, msg: string, extra = {}){
    for(const user of users){
        await bot.telegram.sendMessage(user.chatID, msg, extra)
    }
}

function parseFolder(
    el: Cheerio<Element>,
    parent: TreeNodeFolder|undefined,
    parseFunc: (el: Element, parent?: TreeNodeFolder) => TreeNodeFolderOrFile
): TreeNodeFolder {
    let first = el.children().first()
    let folder = new TreeNodeFolder(first.text().trim(), parent)
    folder.children = first.next().children().map((i, el) => parseFunc(el, folder)).toArray()
    return folder
}
function parseFile(el: Cheerio<Element>, parent: TreeNodeFolder): TreeNodeFile {
    return new TreeNodeFile(el.text().trim(), parent, el.attr('href')?.trim() ?? '')
}

function escape(msg: string){
    return msg.replace(/([\_\*\[\]\(\)\~\`\>\#\+\-\=\|\{\}\.\!])/g, '\\$1')
}

async function checkForUpdates(){
    console.log('checking...')

    const response = await fetch('https://www.sevsu.ru/univers/shedule/')
    const body = await response.text()
    
    const $ = load_html(body)
    const root = $('.schedule-table')
    let new_tree =
    parseFolder(root, undefined, (el, parent) =>
        parseFolder($(el), parent, (el, parent) =>
            parseFolder($(el), parent, (el, parent) => {
                    let children = $(el).children()
                    let folder = new TreeNodeFolder(
                        children.first().text().trim(),
                        parent
                    )
                    folder.children = children.slice(1).map((i, el) => {
                        return parseFile($(el), folder)
                    }).toArray()
                    return folder
                }
            )
        )
    )

    let report = update(new_tree, tree)
    tree = new_tree
    treeIndex = tree.buildIndex()
    console.log(
        `added: ${report.added.length} ` +
        `removed: ${report.removed.length} ` + 
        `modified: ${report.modified.length} `
    )

    for(let folderORfile of report.added){
        await folderORfile.download()
    }
    for(let file of report.modified){
        await file.download()
    }

    for(let folderORfile of report.added){
        let subs = folderORfile.getSubscribers()
        await broadcast(subs, `*Добавлен ${folderORfile.type.toUpperCase()}*\n${escape(folderORfile.path)}`, {
            parse_mode: 'MarkdownV2'
        })
    }

    for(let folderORfile of report.removed){
        let subs = folderORfile.getSubscribers()
        await broadcast(subs, `*Удалён ${folderORfile.type.toUpperCase()}*\n${escape(folderORfile.path)}`, {
            parse_mode: 'MarkdownV2'
        })
    }

    for(let file of report.modified){
        let extra = {
            ...Markup.inlineKeyboard([
                [ Markup.button.url('Скачать с сайта', 'https://www.sevsu.ru' + file.url) ]
            ]),
            parse_mode: 'MarkdownV2'
        }
        let subs = file.getSubscribers()
        await broadcast(subs, `*Изменён файл*\n${escape(file.path)}`, extra)

        let updates = await file.compare()
        for(let [range, update] of updates.entries()){
            let subs = range.getSubscribers()
            await broadcast(
                subs,
                `*Диапазон "${escape(range.alias)}" (${escape(range.name)})*\n` + escape(
                    `${file.path}\n` +
                    `Был изменён на страницах:${update.modified.join('\n')}\n` +
                    `Был добавлен на страницы:${update.added.map(x => x.sheetName).join('\n')}`,
                ), extra
            )
        }
    }
    console.log('check finished')
}

class TreeUpdateReport {
    removed: TreeNodeFolderOrFile[] = []
    added: TreeNodeFolderOrFile[] = []
    modified: TreeNodeFile[] = []
}

function update(new_node: TreeNodeFolderOrFile, old_node: TreeNodeFolderOrFile, report = new TreeUpdateReport()){
    new_node.subscribers = old_node.subscribers
    if(TreeNodeFile.is(old_node) && TreeNodeFile.is(new_node)){
        if(new_node.url != old_node.url){
            report.modified.push(new_node)
        }
        new_node.children = old_node.children
        new_node.saves = old_node.saves
    } else if(TreeNodeFolder.is(old_node) && TreeNodeFolder.is(new_node)){
        report.removed.concat(
            old_node.children.filter(
                old_child => new_node.children.find(
                    new_child => new_child.id == old_child.id
                ) == undefined
            )
        )
        for(let new_child of new_node.children){
            let old_child = old_node.children.find((c: TreeNodeFolderOrFile) => c.id == new_child.id)
            if(old_child){
                update(new_child, old_child, report)
            } else {
                report.added.push(new_child)
            }
        }
    } else {
        console.log('type changed!')
        // if(TreeNodeFolder.is(old_node) && TreeNodeFile.is(new_node)){
        //     report.added.push(new_node)
        //     report.removed.concat(old_node.children)
        // }
    }
    return report
}

type SimpleObj = { [key: number|string]: number|string }
function enc_data(params: SimpleObj): string {
    return Object.entries(params).map(([key, value]) => key + '=' + value).join('&')
}
function dec_data(query: string): SimpleObj {
    return Object.fromEntries(query.split('&').map(kv => kv.split('=').map(v => +v || v)))
}
function hasFlags(e: number|undefined, flags: number){
    return (e! & flags) == flags
}

enum MenuBtnFlags {
    dontDelete = 1 << 0,
    singleFile = 1 << 1,
    checked = 1 << 2,
    forceSubscription = 1 << 3,
}
type MenuParams = {
    id: string,
    flags: MenuBtnFlags
}
const menu_cb_btn = (msg: string, params: MenuParams) =>
    Markup.button.callback(msg, 'menu?' + enc_data(params))

//TODO:
const selectAnotherFileButton = () =>
    menu_cb_btn('Выбрать другой файл', { id: tree.id, flags: MenuBtnFlags.dontDelete })
const toggleFileButton = (fid: string, checked: boolean) =>
    menu_cb_btn(
        checked ? 'Отслеживается 👁️' : 'Следить за ним',
        { id: fid, flags: MenuBtnFlags.singleFile | (checked ? MenuBtnFlags.checked : 0) }
    )

function getUser(cid: number){
    return (users[cid] || (users[cid] = new User(cid)))
}

let menu = async (ctx: Context & { match?: RegExpMatchArray }) => {
    let m = ctx.match
    let p: undefined | MenuParams
    if(m && m[1]){
        p = dec_data(m[1]) as MenuParams
    }
    let id = p?.id || '0' //TODO: protect/remove

    let singleFile = hasFlags(p?.flags, MenuBtnFlags.singleFile) // added message
    let dontDelete = hasFlags(p?.flags, MenuBtnFlags.dontDelete) // removed message
    let checked = hasFlags(p?.flags, MenuBtnFlags.checked)
    let forceSubscription = hasFlags(p?.flags, MenuBtnFlags.forceSubscription)

    let queryAnswered = false
    let user = getUser(ctx.chat!.id) //TODO: fix!
    let node = treeIndex[id]
    if(!node){
        if(singleFile){
            await ctx.answerCbQuery('Файл не найден ❌')
            await select_another_file(ctx)
            return
        }
        await ctx.answerCbQuery('Путь не найден ❌')
        queryAnswered = true
        node = tree
    }
    let subscribed = false
    let folderORfile: TreeNodeFolderOrFile
    let leaf = TreeNodeRange.is(node) || (TreeNodeFile.is(node) && !node.supportsRanges())
    if(forceSubscription || leaf){
        folderORfile = (leaf ? node.parent : node) as TreeNodeFolderOrFile //TODO: wired.
        let sset = user.subscriptions
        subscribed = sset.has(id)
        if(subscribed != checked){
            if(subscribed){
                await ctx.answerCbQuery('Вы уже подписались ❌')
            } else {
                await ctx.answerCbQuery('Вы уже отписались ❌')
            }
        } else if(subscribed){
            sset.delete(id)
            node.subscribers.delete(user)
            console.log(user.chatID, 'unsubscribed from', id)
            await ctx.answerCbQuery('Вы отписались ✔️')
            subscribed = false
            checked = false
        } else {
            sset.add(id)
            node.subscribers.add(user)
            console.log(user.chatID, 'subscribed to', id)
            await ctx.answerCbQuery('Вы подписались ✔️')
            subscribed = true
            checked = true
        }
        queryAnswered = true
    } else {
        folderORfile = (node as TreeNodeFolderOrFile) //TODO: wired.
    }

    let buttons = []
    let flags = (dontDelete ? MenuBtnFlags.dontDelete : 0) |
                (singleFile ? MenuBtnFlags.singleFile : 0)

    if(TreeNodeFile.is(folderORfile)){
        let file = folderORfile
        for(let range of file.children){
            let checked = range.subscribers.has(user)
            buttons.push([
                menu_cb_btn((checked ? '🟢 ' : '') + range.alias, {
                    id: range.id,
                    flags: flags | (checked ? MenuBtnFlags.checked : 0)
                })
            ])
        }
        buttons.push([
            Markup.button.callback('Добавить свой диапазон', 'add_range?' + enc_data({ id }))
        ])
    } else {
        let folder = folderORfile
        for(let child of folder.children){
            let checked = child.hasSubscriber(user)
            buttons.push([
                menu_cb_btn((checked ? '🔵 ' : '') + child.name, {
                    id: child.id,
                    flags: flags | (checked ? MenuBtnFlags.checked : 0)
                })
            ])
        }
    }
    checked = folderORfile.subscribers.has(user)
    buttons.push([
        menu_cb_btn(
            (checked ? '🔵 ' : '') + (TreeNodeFolder.is(folderORfile) ? 'Вся папка' : 'Весь файл'),
            { id: folderORfile.id, flags: flags | MenuBtnFlags.forceSubscription | (checked ? MenuBtnFlags.checked : 0) }
        )
    ])
    if(folderORfile.parent && !singleFile){ // if not root folder
        buttons.push([
            menu_cb_btn('< Назад >', { id: folderORfile.parent.id, flags })
        ])
    }
    buttons.push([
        Markup.button.callback('> Закрыть <', dontDelete ? 'close' : 'delete')
    ])
    
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
bot.action(/^menu\?(.*)/, menu)
const ENTER_RANGE_FOR = 'Введите диапазон для '
const EnterRangeForRegExp = new RegExp('^' + ENTER_RANGE_FOR + '(.*)')
bot.action(/^add_range\?(.*)/, async (ctx) => {
    let m = ctx.match
    let p = dec_data(m[1])
    let id = p.id
    await ctx.sendMessage(ENTER_RANGE_FOR + id, Markup.forceReply())
})
bot.action('delete', async (ctx) => {
    await ctx.deleteMessage()
})
const select_another_file = async (ctx: Context) => {
    await ctx.editMessageReplyMarkup({
        inline_keyboard: [[ selectAnotherFileButton() ]]
    })
}
bot.action('close', select_another_file)
bot.command('menu', menu)

bot.command('stats', async (ctx) => {
    let cid = ctx.chat.id
    console.log(cid, 'запросил статус')
    await ctx.sendMessage('Статус: жив\nПодписалось: ' + Object.keys(users).length)
})
bot.command('help', async (ctx) => {
    await ctx.sendMessage('/menu - управление слежением\n/stats - бот, ты как?')
})

bot.on('text', async (ctx) => {
    let cid = ctx.chat.id
    let user = getUser(cid)
    let reply = ctx.message.reply_to_message
    if(reply && 'text' in reply){
        let text = reply.text
        let m
        if(m = text.match(EnterRangeForRegExp)){
            let id = m[1]
            let node = treeIndex[id]
            if(node){
                if(TreeNodeFile.is(node)){
                    let file = node
                    if(file.supportsRanges()){
                        let addr = ctx.message.text
                        if(addr.match(/^[a-z]+[0-9]+:[a-z]+[0-9]+$/i)){
                            let range = xlsx.utils.decode_range(addr)
                            let existing = file.children.find(c => c.name == addr)
                            if(!existing){
                                
                                let rangeNode = new TreeNodeRange(addr, file, range)
                                file.children.push(rangeNode)
                                treeIndex[rangeNode.id] = rangeNode

                                user.subscriptions.add(rangeNode.id)
                                rangeNode.subscribers.add(user)
                                
                                console.log(user.chatID, 'subscribed to new range', rangeNode.id)
                                await ctx.sendMessage('Диапазон создан, вы подписаны')
                            } else {
                                await ctx.sendMessage('Диапазон уже существует')
                            }
                        } else {
                            await ctx.sendMessage('Диапазон не распознан')
                        }
                    } else {
                        await ctx.sendMessage('Файл не поддерживает диапазоны')
                    }
                } else {
                    await ctx.sendMessage('Узел не является файлом')
                }
            } else {
                await ctx.sendMessage('Узел не найден')
            }
        } else {
            await ctx.sendMessage('Не понял...')
        }
    }
})

const stop = async (reason: string = 'unspecified') => {
    clearInterval(checkInterval)
    try {
        bot.stop(reason)
    } catch(e) {
        console.log(e)
    }
    await fs.promises.writeFile(
        'db.json',
        JSON.stringify(save({ users, tree })),
        'utf8'
    )
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))

bot.launch()
let checkInterval = setInterval(checkForUpdates, 1000 * 60 * 60 * 1)
checkForUpdates()
console.log('запущен')
//await tree.download(true);
//stop()