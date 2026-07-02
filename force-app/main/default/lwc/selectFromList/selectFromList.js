import { LightningElement,track,api } from 'lwc';

export default class SelectFromList extends LightningElement {
    _selectedRows = new Map();
    _columns = [];
    @track _records = [];
    isPicklistDisabledMap = new Map(); // Map which holds picklist status for all rows
    _showResults=false;

    @api
    set columns(columns) {
        this._columns = columns;
    }
    
    get columns() {
        return this._columns;
    }

    @api
    set records(records) {
        if(records.length > 0) {
            console.log('selectFromList length: ' + records.length);
            const copyData = JSON.parse(JSON.stringify(records));
            this.isPicklistDisabledMap = new Map();
            for (const record of copyData) {
                this.isPicklistDisabledMap.set(record.id, true);
            }
            this._records = [...copyData];
            this._showResults = true;
            console.log('selectFromList _showResults: ' + this._showResults);
        } else {
            console.log('selectFromList length: ' + records.length);
            this._showResults = false;
            console.log('selectFromList _showResults: ' + this._showResults);
        }
    }
    
    get records() {
        return this._records;
    }

    updateDataValues(updateItem) {
        const copyData = [...this._records];
        copyData.forEach(item => {
            if (item.id === updateItem.id) {
                for (const field in updateItem) {
                    item[field] = updateItem[field];
                }
            }
        });
        this._records = [...copyData];
    }

    picklistChanged(event) {
        event.stopPropagation();
        const dataRecieved = event.detail.data;
        let updatedItem;
        if(dataRecieved.columnname == 'Role') {
            updatedItem ={ id: dataRecieved.context, role: dataRecieved.value };
        } else if(dataRecieved.columnname == 'Status') {
            updatedItem ={ id: dataRecieved.context, status: dataRecieved.value };
        } else {
            console.log("Invalid column");
        }
        this.updateDataValues(updatedItem);
        // Update this._selectedRows with the new values and send datachanged event
        if(this._selectedRows.has(dataRecieved.context)){
            let prevVal = this._selectedRows.get(dataRecieved.context);
            let newVal;
            if(dataRecieved.columnname == 'Role') {
                newVal = {
                    id: prevVal.id,
                    pid: prevVal.pid,
                    name: prevVal.name,
                    role: dataRecieved.value,
                    status: prevVal.status
                };

            } else if(dataRecieved.columnname == 'Status') {
                newVal = {
                    id: prevVal.id,
                    pid: prevVal.pid,
                    name: prevVal.name,
                    role: prevVal.role,
                    status: dataRecieved.value
                };
            } else {
                console.log("Invalid column");
            }
            this._selectedRows.set(dataRecieved.context,newVal);
        }
        this.sendDataChanged();
    }

    handleSelectedRows(event) {
        const selectedRows = event.detail.selectedRows;
        this._selectedRows = new Map();
        let currentSelection = new Map();
        for (let i = 0; i < selectedRows.length; i++) {
            currentSelection.set(selectedRows[i].id, false);
            this._selectedRows.set(selectedRows[i].id, 
                {id: selectedRows[i].id,
                pid: selectedRows[i].pid,
                name: selectedRows[i].name,
                role: selectedRows[i].role,
                status: selectedRows[i].status});
        }
        for (let [key, value] of this.isPicklistDisabledMap.entries()) {
            if(currentSelection.has(key)) { 
                this.isPicklistDisabledMap.set(key, false);
            } else {
                this.isPicklistDisabledMap.set(key, true);
            }
        }
        const copyData = [...this._records];
        copyData.forEach(item => {
            item.isdisabled = this.isPicklistDisabledMap.get(item.id);
        });

        // write changes back to original data
        this._records = [...copyData];
        this.sendDataChanged();
    }

    sendDataChanged(){
        let selectedData=[];
        for (let [key, value] of this._selectedRows.entries()) {
            selectedData.push({
                id: value.id,
                pid: value.pid,
                name: value.name,
                role: value.role,
                status: value.status
            })
        }
        const event = new CustomEvent('datachanged', {
            detail:selectedData
        });
        this.dispatchEvent(event);
    }
}