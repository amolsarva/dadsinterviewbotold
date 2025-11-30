import { createClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function GET() {
    const { error, data } = await supabase
        .rpc('health_check');

    if (error) {
        return NextResponse.json({
            status: 'error',
            message: 'Supabase is down!',
            recoveryInstructions: [
                'Check your Supabase instance in the Supabase Dashboard.',
                'Verify your database connection settings.',
                'Ensure your Supabase services are running.'
            ]
        }, { status: 500 });
    }

    return NextResponse.json({
        status: 'success',
        message: 'Supabase is healthy!',
        data: data
    });
}