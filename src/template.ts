import { promises as fs } from "fs";
import path from "path";

export default function render(string: string, options: { [k: string]: string | number }) {
    for (let key in options) {
        string = string.replace(new RegExp('\\*' + key + '\\*', 'g'), String(options[key]));
    }

    var unrendered = string.match(/\*[a-zA-Z0-9_]+\*/g);

    if (unrendered) {
        console.warn('[warning] unrandered variable: ' + unrendered.join(', '));
    }

    return string;
}

export const CLIENT_TEMPLATE_DIR = path.join(__dirname, '../template/client')

/** the parts of run.sh in file name order, each after the first under a line naming it */
export async function readClientTemplate(dir = CLIENT_TEMPLATE_DIR) {
    const names = (await fs.readdir(dir)).filter(name => name.endsWith('.sh')).sort()
    const parts = await Promise.all(names.map(name => fs.readFile(path.join(dir, name), 'utf8')))
    return parts
        .map((part, i) => i === 0 ? part : `# ===== ${names[i]} =====\n${part}`)
        .join('\n')
}
