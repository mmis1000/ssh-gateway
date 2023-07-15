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