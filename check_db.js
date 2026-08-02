const mongoose = require('mongoose');

const uri = 'mongodb://mongo:DiGaBWUZXCkIxlZMuntztBaFJcOlUJIg@maglev.proxy.rlwy.net:40270/harx?authSource=admin';

async function check() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(uri);
        console.log('Connected to MongoDB');

        const userIdStr = '698b11d85497af9a47bd3717';
        const userId = new mongoose.Types.ObjectId(userIdStr);

        // Check User
        const user = await mongoose.connection.db.collection('users').findOne({ _id: userId });
        console.log('User found:', user ? 'Yes' : 'No');
        if (user) console.log('User name:', user.name);

        // Check Agent by userId field
        const agentByUserId = await mongoose.connection.db.collection('agents').findOne({ userId: userId });
        console.log('Agent found by userId field:', agentByUserId ? 'Yes' : 'No');
        if (agentByUserId) {
            console.log('Agent _id:', agentByUserId._id);
            console.log('Agent keys:', Object.keys(agentByUserId));
            console.log('Agent personalInfo:', JSON.stringify(agentByUserId.personalInfo, null, 2));
        }

        // Check Agent by its own _id (just in case)
        const agentById = await mongoose.connection.db.collection('agents').findOne({ _id: userId });
        console.log('Agent found by _id field:', agentById ? 'Yes' : 'No');

        // List some agents to see the structure
        const someAgents = await mongoose.connection.db.collection('agents').find().limit(2).toArray();
        console.log('Sample agents structure:');
        someAgents.forEach(a => {
            console.log('---');
            console.log('_id:', a._id);
            console.log('Keys:', Object.keys(a));
            if (a.userId) console.log('userId field:', a.userId);
            if (a.user) console.log('user field:', a.user);
        });

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

check();
