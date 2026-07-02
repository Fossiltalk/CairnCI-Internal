/*
 * Copyright 2022 salesforce.com, inc.
 * All Rights Reserved
 * Company Confidential
 */
import LightningDatatable from 'lightning/datatable';
//import the template so that it can be reused
import DatatablePicklistTemplate from './picklist-template.html';

export default class CustomDataTable extends LightningDatatable {
    static customTypes = {
        picklist: {
            template: DatatablePicklistTemplate,
            typeAttributes: ['label', 'placeholder', 'options', 'value', 'context', 'columnname', 'isdisabled'],
        },

    };

    constructor() {
        super();
        console.log("Inside custom data-table constructor");
    }
}