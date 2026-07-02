/*
 * Usage : ./node scripts/getAllCustomLabels.js LANGUAGECODE
 *
 * Example : ./node scripts/getAllCustomLabels.js en_US
 * Example using npm run : npm run customlabels en_US
 *
 * Input :
 *
 * Searchs the src/modules directory for all multi-language *_def.js* and *omnidef_chunk*.js files
 * 1) If *_def.js* , parse them and merge with other labelKeyMaps
 * 2) If *omnidef_chunk*.js, merge the chunks, b64 -> string -> uridecode -> parse json and merge labelKeyMap
 *
 * Output :
 * If there are any multi-language omniscripts
 * Creates a file LANG.translation.js that contains the variable LANG set equal to the labelKeyMap containing
 * all of the labelKeyMaps in jsonDefs. This will only contain something if there are multi-language OmniScripts
 */

const path = require('path')
const fs = require('fs');

function findFile(startPath,filter,callback){

    if (!fs.existsSync(startPath)){
        console.log("Directory " + startPath + " not found.");
        return;
    }

    const files = fs.readdirSync(startPath);
    for(let i = 0; i < files.length; i++){
        const filename = path.join(startPath,files[i]);
        const stat = fs.lstatSync(filename);
        if (stat.isDirectory()){
			// search for file in subdirectories
            findFile(filename, filter, callback);
        }
        else if (filter.test(filename)) {
			callback(filename);
		}
    };
};

function findFileHandler(filepath) {
	//console.log(filepath);
	const filepaths = filepath.split(path.sep);
	const filename = filepaths.pop();
	const modulepath = filepaths.join(path.sep);
	if(!filesFound.hasOwnProperty(modulepath)) {
		filesFound[modulepath] = {};
	}
	filesFound[modulepath][filename] = true;
}

function atob(b64Encoded) {
	return Buffer.from(b64Encoded, 'base64').toString()
}

function getLabelKeyMap(modules) {
	const allLabelKeyMap = {};
	const moduleNamePaths = Object.keys(modules);
	moduleNamePaths.forEach((modulePath) => {
		const moduleObj = modules[modulePath];
		const moduleObjKeys = Object.keys(moduleObj);
		const labelKeyMap = {};

		// if jsonDef is split up (since it is too big for a single file)
		if(moduleObjKeys.length > 1) {
			let chunk = '';

			for(let i = 0; i < moduleObjKeys.length - 1; i++) {
				// name of the jsondef chunk files
				const fileName = 'omnidef_chunk' + i + '.js';
				if(moduleObj.hasOwnProperty(fileName)) {
 					const data = removeExport(fs.readFileSync(path.join(currentDir, modulePath, fileName), "utf8"));
					// find first double quote "
					const firstQuoteIndex = data.indexOf('"') + 1;
					const secondQuoteIndex = data.lastIndexOf('"');
					chunk += data.slice(firstQuoteIndex, secondQuoteIndex);
					// find second double quote "
				}
			}
			if(chunk.length > 0) {
				const jsonDefStr = decodeURIComponent(atob(chunk));
				let jsonDef = {};
				try {
					jsonDef = JSON.parse(jsonDefStr);
				}
				catch(error) {
					console.error(error);
				}
				Object.assign(labelKeyMap, jsonDef.labelKeyMap ? jsonDef.labelKeyMap : {});
			}
		}
		// json def not split up, so actual javascript object defined
		else if(moduleObjKeys.length === 1) {
			const fileName = moduleObjKeys[0];
			const data = removeExport(fs.readFileSync(path.join(currentDir, modulePath, fileName), "utf8"));

			let jsonDef = {};
			try {
				'use strict';
				// load jsonDef contents
				eval(data);
				jsonDef = OMNIDEF;
			}
			catch(error) {
				console.error(error);
			}
			Object.assign(labelKeyMap, jsonDef.labelKeyMap ? jsonDef.labelKeyMap : {});
		}
		// merge into one label key map
		Object.assign(allLabelKeyMap, labelKeyMap);
	});

	return allLabelKeyMap;
}

// removes export substring from a string
function removeExport(inputStr) {
	if(typeof inputStr !== 'string') {
		return inputStr;
	}
	return inputStr.replace(/export\s*const\s*/g, 'var ').replace(/export\s/,'');
}

function getOuiModulePath() {
	// checks inside lwc.config.json for the path to oui npm modules
	const data = fs.readFileSync(path.join('.', 'lwc.config.json'), "utf8");
	let _path;
	try {
		const lwcConfig = JSON.parse(data);
		// find the npm path for oui
		_path = lwcConfig.modules.filter(value => value.npm)
			  .reduce((acc, value) => {
				  if(value.npm.indexOf('/oui') > -1) return value.npm
				  return ''
			  } );
		return _path;
	}
	catch(e) {
		console.log(e);
	}
	return _path;
}


// MAIN
const ouiModulePath = getOuiModulePath();
if(!ouiModulePath) {
	console.log('Error: oui npm module path not found');
	return ;
}

const filesFound = {};
const labelKeyMapOriginalPath = path.join('.', 'node_modules', ouiModulePath, 'src', 'modules', 'c', 'omniscriptRestApi','customLabels.js');
const pathToTranslations = path.join('src', 'modules', 'vlocitytranslations');
const defaultPrefix = 'LANG';
const currentDir = process.cwd();
const langCode = process.argv[2] || '';

if(langCode.indexOf('-') > -1) {
	//hyphens also break javascript import/export since they cannot be part of a variable name
	console.error('Error : Language codes with hyphens "-" are not supported. Please refer to Salesforce\'s supported language codes : https://help.salesforce.com/articleView?id=faq_getstart_what_languages_does.htm&type=5');
	return;
}

const prefix = langCode || defaultPrefix;

let labelKeyMapOriginal = {};

// get labelKeyMap
try {
	'use strict';
	// need to change const to var in order to expose variable when eval'd
	// removing export keyword in order for eval to work
	const data = removeExport(fs.readFileSync(labelKeyMapOriginalPath, "utf8"));
	eval(data);
	labelKeyMapOriginal = allCustomLabels;
}
catch(err) {
	console.error(err);
}

// search for json def files in multi-language omniscripts
findFile(path.join('.', 'src', 'modules'), new RegExp(`MultiLanguage\\${path.sep}.*_def.js`), findFileHandler);
findFile(path.join('.', 'src', 'modules'), new RegExp(`MultiLanguage\\${path.sep}omnidef_chunk\\d*.js`), findFileHandler);

const labelKeyMapCustom = getLabelKeyMap(filesFound);

if(Object.keys(labelKeyMapCustom).length < 1) {
	console.log('No Multi-Language OmniScript Detected');
	return ;
}

const labelKeyMapAll = Object.assign({}, labelKeyMapOriginal, labelKeyMapCustom);

let translationFilePath = '';
let fileName = '';
let baseName = '';
let i = 0;
do {
	// append number if file already exists
	baseName = prefix + (i === 0 ? '' : i);
	fileName = baseName + '.translations.js';
	translationFilePath = path.join(pathToTranslations, fileName);
	i++;
}
while(fs.existsSync(translationFilePath));

// create directory "vlocitytranslations"
if (!fs.existsSync(pathToTranslations)) {
	fs.mkdirSync(pathToTranslations);
}

// create translation file "LANGCODE.translations.js"
const outStr = 'export const ' + baseName + ' = ' + JSON.stringify(labelKeyMapAll, null, 4);
const translationFileFullPath = path.join(currentDir, translationFilePath);
fs.writeFileSync(translationFileFullPath, outStr);

// create translation.js or append to the file
const outStr2 = `//export * from "./${fileName}";\n`;
const translationFileFullPath2 = path.join(currentDir, pathToTranslations, 'translations.js');
fs.appendFileSync(translationFileFullPath2, outStr2);
