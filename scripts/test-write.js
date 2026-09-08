var fs = require('fs');
var path = require('path');
var home = require('os').homedir();
var outFile = path.join(home, 'db_check_result.txt');
fs.writeFileSync(outFile, 'hello from node at ' + new Date().toISOString() + '\n');