function getTemplateField(fieldName) {
    if (window.IsFoundation){
        return window.DocTemplateFieldMappings[fieldName];
    } else {
        var namespace = window.nameSpacePrefix ? window.nameSpacePrefix : '';
        return namespace+fieldName;
    }
};
