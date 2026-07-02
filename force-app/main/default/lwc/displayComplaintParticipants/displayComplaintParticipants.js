import { LightningElement,wire,track,api } from 'lwc';
import { OmniscriptBaseMixin } from "omnistudio/omniscriptBaseMixin";
import pubsub from 'omnistudio/pubsub';
import { getPicklistValues } from 'lightning/uiObjectInfoApi';

export default class DisplayComplaintParticipants extends OmniscriptBaseMixin(LightningElement) {
    rolePicklistValues; // Holds ComplaintParticipant.Role picklist values via @wire adaptor
    roleError;
    statusPicklistValues; // Holds ComplaintParticipant.Status picklist values via @wire adaptor
    statusError;

    @track columns = [];
    @track records = [];

    @wire(getPicklistValues, {
        recordTypeId: '012hk0000007VT1AAA', fieldApiName: 'ComplaintParticipant.Role'
    })
    wiredRolePicklistValues({data, error}) {
        if(data){
            this.rolePicklistValues = data.values;
            if(typeof(this.rolePicklistValues) != "undefined" && typeof(this.statusPicklistValues) != "undefined" && this.rolePicklistValues.length > 0 && this.statusPicklistValues.length > 0) {
                this.initializeDatatableColumns();
            }
            
            this.roleError=undefined;
        }
        if(error){
            console.log(`Error while fetching ComplaintParticipant.Role picklist: ${error}`);
            this.roleError=error;
            this.rolePicklistValues = undefined;
        }
    };

    @wire(getPicklistValues, {
        recordTypeId: '012hk0000007VT1AAA', fieldApiName: 'ComplaintParticipant.Status'
    })
    wiredStatusPicklistValues({data, error}) {
        if(data){
            this.statusPicklistValues = data.values;
            if(typeof(this.rolePicklistValues) != "undefined" && typeof(this.statusPicklistValues) != "undefined" && this.rolePicklistValues.length > 0 && this.statusPicklistValues.length > 0) {
                this.initializeDatatableColumns();
            }
            this.statusError = undefined;
        }
        if(error){
            console.log(`Error while fetching ComplaintParticipant.Status picklist: ${error}`);
            this.statusError = error;
            this.statusPicklistValues = undefined;
        }
    };

    @api
    set recordList(recordList) {
        const copyData = JSON.parse(JSON.stringify(recordList));
        if(copyData.length > 0) { 
            copyData.forEach(item => {
                let record = {
                    id: item.Id,
                    pid: item.ParticipantId,
                    role: item.Role,
                    status: item.Status,
                    name: item.Participant.Name,
                    isdisabled: true
                };
                this.records.push(record);
            });
        } else {
            this.records = [];
        }
    }
    
    get recordList() {
        return this.records;
    }

    initializeDatatableColumns(){
        this.columns = [
            { label: 'Participant', fieldName: 'name'},
            {
                label: 'Role', fieldName: 'role', type: 'picklist', typeAttributes: {
                    placeholder: 'Choose Role', options: this.rolePicklistValues,
                    value: { fieldName: 'role' },
                    context: { fieldName: 'id' }, // binding Id with context variable to be returned back
                    columnname: 'Role',
                    isdisabled: {fieldName: 'isdisabled'}
                }
            },
            {
                label: 'Status', fieldName: 'status', type: 'picklist', typeAttributes: {
                    placeholder: 'Choose Status', options: this.statusPicklistValues,
                    value: { fieldName: 'status' },
                    context: { fieldName: 'id' }, // binding Id with context variable to be returned back
                    columnname: 'Status',
                    isdisabled: {fieldName: 'isdisabled'}
                }
            },
        ];
    };

    sendDataChanged(event){
        let selectedData = event.detail;
        pubsub.fire("rowSelection", 'pc_participants_selection_changed', {"selectedData": selectedData});
    }
}