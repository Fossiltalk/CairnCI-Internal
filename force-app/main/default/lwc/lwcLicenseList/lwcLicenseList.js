import { LightningElement,api,track } from 'lwc';
import { OmniscriptBaseMixin } from "omnistudio/omniscriptBaseMixin";

const columns = [
    { label: 'Account Name', fieldName: 'AccountName' },
    { label: 'Business Type', fieldName: 'BusinessTypeName' },
    { label: 'Address', fieldName: 'Address' },
    { label: 'Business Operating Name', fieldName: 'BusinessOperatingName' }
];

export default class lwcdatatable extends OmniscriptBaseMixin(LightningElement) {
    @track columns = columns;
    _jsonDef;
    _headerJson;
    _omniJsonData;
    _showResults=false;
    _zeroRecord=false;
    _licenseList; // Needs to match the OS parameter
    
    @api
    set omniJsonDef(json) {
        if(json) {
            this._jsonDef = json;
        }
    }

    get omniJsonDef() {
        return this._jsonDef;
    }

    @api 
    set omniScriptHeaderDef(headerJson) {
        if(headerJson) {
            this._headerJson = headerJson;
        }
    }

    get omniScriptHeaderDef() {
        return this._headerJson;
    }

    @api
    set omniJsonData(omniData) {
        if(omniData) {
            this._omniJsonData = omniData;
        }
    }

    get omniJsonData() {
        return this._omniJsonData;
    }

    // Needs to match the OS parameter
    @api
    set licenseList(licenseList) {
        console.log('### this._licenseList:  ' + licenseList + ';');
        if(licenseList) {
            this._licenseList = licenseList;

            if (licenseList.length == 0) {
                console.log('Found zero record');
                this._zeroRecord=true;
                this._showResults=false;
            }
            else
            {
                this._zeroRecord=false;
                this._showResults=true;
            }
        }
    }
    
    // Needs to match the OS parameter
    get licenseList() {
        console.log('$$$ this._licenseList:  ' + this._licenseList + ';');
        return this._licenseList;
    }

}