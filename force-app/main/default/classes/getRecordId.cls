public class getRecordId {
    
    @AuraEnabled(cacheable=true)
    public static String getOrgBaseUrl(){
        List<Domain> mylist = [SELECT Domain FROM Domain WHERE Domain LIKE '%site.com%' LIMIT 1];
        String domain_name = mylist[0].Domain;
        return domain_name;
    }

    @AuraEnabled(cacheable=true)
    public static List<IndividualApplication> getIndAppId(){
        return [SELECT Id FROM IndividualApplication WHERE Name LIKE '%IA-0000000001%' LIMIT 1];
    }

    @AuraEnabled(cacheable=true)
    public static List<Contact> getContactId(){
        return [SELECT Id FROM Contact WHERE FirstName LIKE '%Carole%' LIMIT 1];
    }

    @AuraEnabled(cacheable=true)
    public static List<Account> getAccountId(){
        return [SELECT Id FROM Account WHERE LastName LIKE '%Holmes%' LIMIT 1];
    }

    @AuraEnabled(cacheable=true)
    public static List<Account> getPersonAccountId(){
        return [SELECT Id FROM Account WHERE LastName LIKE '%Rodrigues%' LIMIT 1];
    }
    @AuraEnabled(cacheable=true)
    public static List<User> getUserId(){
        return [SELECT Id FROM User WHERE Name = 'Dinesh Kumar' LIMIT 1];
    }
    @AuraEnabled(cacheable=true)
    public static List<ApplicationForm> getAppFormId(){
        return [SELECT Id FROM ApplicationForm WHERE Account.LastName like '%Rodrigues%' LIMIT 1];
    }
}