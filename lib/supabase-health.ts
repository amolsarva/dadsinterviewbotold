// lib/supabase-health.ts

import { createClient } from '@supabase/supabase-js';
import { SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

async function validateServiceRoleAuth() {
    // Check if the service role authentication works
    const { data, error } = await supabase.auth.api.getUser();
    if (error) {
        throw new Error('Service role authentication failed: ' + error.message);
    }
    return data;
}

async function validateTurnsTableSchema() {
    // Validate if the turns table exists and has the correct schema
    const { data, error } = await supabase
        .from('turns')
        .select('*')
        .limit(1);
  
    if (error || data.length === 0) {
        throw new Error('Turns table schema is invalid or does not exist');
    }
    return true;
}

async function checkStorageBucketAccess() {
    // Check if we can access the storage bucket
    const { data, error } = await supabase.storage.from('my-bucket').list();
    if (error) {
        throw new Error('Storage bucket access failed: ' + error.message);
    }
    return data;
}

async function checkStorageWritePermissions() {
    // Try to upload a test file to check write permissions
    const { error } = await supabase.storage
        .from('my-bucket')
        .upload('test.txt', new Blob(['test content']));
        
    if (error) {
        throw new Error('Storage write permissions failed: ' + error.message);
    }
    return true;
}

async function runHealthCheckSuite() {
    try {
        await validateServiceRoleAuth();
        await validateTurnsTableSchema();
        await checkStorageBucketAccess();
        await checkStorageWritePermissions();
        console.log('All checks passed.');
    } catch (error) {
        console.error('Health Check Failed: ', error.message);
        console.log('Recovery instructions: Ensure your Supabase configurations are correct and your service role has the required permissions.');
    }
}

export {
    validateServiceRoleAuth,
    validateTurnsTableSchema,
    checkStorageBucketAccess,
    checkStorageWritePermissions,
    runHealthCheckSuite
};
