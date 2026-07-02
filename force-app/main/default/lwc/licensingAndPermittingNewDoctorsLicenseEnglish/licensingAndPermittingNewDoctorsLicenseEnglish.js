import { api, LightningElement } from 'lwc';
/**
 *  IMPORTANT! Generated class DO NOT MODIFY
 */
export default class licensingAndPermittingNewDoctorsLicenseEnglish extends LightningElement {
    @api dir;
    @api inline;
    @api inlineVariant;
    @api layout;
    @api recordId;
    @api omniscriptId;
    @api prefill;
    @api instanceId;
    @api runMode;

    // not supported in standard runtime but kept
    // for api compatibility.
    @api flexipageRegionWidth;
    @api inlineLabel;
    @api connection;
    @api jsonDataStr;
    @api jsonDef;
    @api seedJson
    @api resume;
    @api scriptHeaderDef;
    @api jsonData;
    @api applyCallResp(data, bApi = false, bValidation = false) {
    }
    @api reportValidity() {
    }
    @api handleInvalid() {
    }
    @api handleAdd() {
    }
    @api handleRemove() {
    }

    get runtimeWrapper() {
        return this.template.querySelector('omnistudio-omniscript-standard-runtime-wrapper')?.generatedOs;
    }
}