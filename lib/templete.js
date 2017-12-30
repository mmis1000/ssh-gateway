module.exports = function render(string, options) {
    for (let key in options) {
        string = string.replace(new RegExp('\\*' + key + '\\*', 'g'), options[key]);
    }
    
    var unrendered = string.match(/\*[a-zA-Z0-9_]+\*/g);
    
    if (unrendered) {
        console.warn('[warning] unrandered variable: ' + unrendered.join(', '));
    }
    
    return string;
}