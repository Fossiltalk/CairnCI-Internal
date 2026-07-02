import { LightningElement, wire, api, track } from 'lwc';
import getIndAppId from '@salesforce/apex/getRecordId.getIndAppId';

export default class InAppLanding extends LightningElement {
    @api welcome_text = "Welcome to Benefit Management Admin Home";
    @api app_description = "Benefit Management is already set up, you can use following steps to verify the required configuration";
    @api no_record_loan_application = false;
    @api no_record_account = false;

    accountId;
    loanApplicationId;

    get pass_false() {
        return false;
    }

    get pass_true() {
        return true;
    }

}