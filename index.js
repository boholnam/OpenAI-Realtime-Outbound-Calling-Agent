import Fastify from 'fastify'; // Import the Fastify framework for building web servers.
import WebSocket from 'ws'; // Import the WebSocket library for handling WebSocket connections.
import dotenv from 'dotenv'; // Import dotenv to load environment variables from a .env file.
import fastifyFormBody from '@fastify/formbody'; // Import Fastify plugin to parse form bodies.
import fastifyWs from '@fastify/websocket'; // Import Fastify plugin to handle WebSocket connections.
import twilio from 'twilio'; // Import the Twilio library for interacting with Twilio's API.

// Load environment variables from .env file
dotenv.config(); // Load environment variables from a .env file into process.env.

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env; // Destructure the OpenAI API key from environment variables.

// Check if the OpenAI API key is available
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.'); // Log an error if the API key is missing.
    process.exit(1); // Exit the process with a failure code.
}

// Twilio Credentials
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); // Initialize Twilio client with account SID and auth token from environment variables.

// Initialize Fastify
const fastify = Fastify(); // Create a new Fastify instance.
fastify.register(fastifyFormBody); // Register the form body parser plugin with Fastify.
fastify.register(fastifyWs); // Register the WebSocket plugin with Fastify.

// Constants
const SYSTEM_MESSAGE = 'You are a persuasive sales agent specializing in plastic surgery services. Your primary goal is to initiate conversations, inform, and convince potential clients about the benefits and options available, while maintaining a friendly and informative tone. Focus on starting the dialogue and highlighting the positive outcomes and advantages of the services offered, aiming to close sales effectively.Start the conversation by asking how the person is doing and then promote servcies '; // Define the system message for the AI assistant.
const VOICE = 'alloy'; // Define the voice to be used by the AI assistant.
const PORT = process.env.PORT || 5050; // Define the port for the server, defaulting to 5050 if not set in environment variables.

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error', // Log error events.
    'response.content.done', // Log when a response content is done.
    'rate_limits.updated', // Log when rate limits are updated.
    'response.done', // Log when a response is done.
    'input_audio_buffer.committed', // Log when input audio buffer is committed.
    'input_audio_buffer.speech_stopped', // Log when speech input stops.
    'input_audio_buffer.speech_started', // Log when speech input starts.
    'session.created' // Log when a session is created.
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false; // Flag to show timing calculations for AI responses.

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' }); // Send a message indicating the server is running.
    console.log('Root route accessed'); // Log access to the root route.
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    console.log('Incoming call route accessed'); // Log access to the incoming call route.
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`; // Define the TwiML response to connect the call to a WebSocket stream.

    reply.type('text/xml').send(twimlResponse); // Send the TwiML response as XML.
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected'); // Log when a client connects to the WebSocket.

        // Connection-specific state
        let streamSid = null; // Initialize the stream SID.
        let latestMediaTimestamp = 0; // Initialize the latest media timestamp.
        let lastAssistantItem = null; // Initialize the last assistant item ID.
        let markQueue = []; // Initialize the mark queue.
        let responseStartTimestampTwilio = null; // Initialize the response start timestamp.

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`, // Set the authorization header with the OpenAI API key.
                "OpenAI-Beta": "realtime=v1" // Set the OpenAI beta header for realtime API.
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update', // Define the session update type.
                session: {
                    turn_detection: { type: 'server_vad' }, // Set turn detection to server VAD.
                    input_audio_format: 'g711_ulaw', // Set input audio format.
                    output_audio_format: 'g711_ulaw', // Set output audio format.
                    voice: VOICE, // Set the voice for the session.
                    instructions: SYSTEM_MESSAGE, // Set the instructions for the session.
                    modalities: ["text", "audio"], // Set the modalities for the session.
                    temperature: 0.8, // Set the temperature for the session.
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate)); // Log the session update being sent.
            openAiWs.send(JSON.stringify(sessionUpdate)); // Send the session update to OpenAI.

            // Uncomment the following line to have AI speak first:
            sendInitialConversationItem(); // Send the initial conversation item.
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create', // Define the conversation item creation type.
                item: {
                    type: 'message', // Set the item type to message.
                    role: 'assistant', // Set the role to assistant.
                    content: [
                        {
                            type: 'input_text', // Set the content type to input text.
                            text: 'Hello! I am your dedicated AI sales agent specializing in plastic surgery services. Let me tell you about our latest offers and how our procedures can enhance your life. Are you interested in learning more about our special promotions today?' // Set the initial message text.
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem)); // Log the initial conversation item if timing math is enabled.
            openAiWs.send(JSON.stringify(initialConversationItem)); // Send the initial conversation item to OpenAI.
            openAiWs.send(JSON.stringify({ type: 'response.create' })); // Send a response creation event to OpenAI.
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio; // Calculate the elapsed time since the response started.
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`); // Log the elapsed time calculation if timing math is enabled.

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate', // Define the conversation item truncation type.
                        item_id: lastAssistantItem, // Set the item ID to the last assistant item.
                        content_index: 0, // Set the content index to 0.
                        audio_end_ms: elapsedTime // Set the audio end time to the elapsed time.
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent)); // Log the truncation event if timing math is enabled.
                    openAiWs.send(JSON.stringify(truncateEvent)); // Send the truncation event to OpenAI.
                }

                connection.send(JSON.stringify({
                    event: 'clear', // Define the clear event type.
                    streamSid: streamSid // Set the stream SID.
                }));

                // Reset
                markQueue = []; // Clear the mark queue.
                lastAssistantItem = null; // Reset the last assistant item.
                responseStartTimestampTwilio = null; // Reset the response start timestamp.
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark', // Define the mark event type.
                    streamSid: streamSid, // Set the stream SID.
                    mark: { name: 'responsePart' } // Set the mark name to responsePart.
                };
                connection.send(JSON.stringify(markEvent)); // Send the mark event to the connection.
                markQueue.push('responsePart'); // Add responsePart to the mark queue.
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API'); // Log when connected to the OpenAI Realtime API.
            setTimeout(initializeSession, 100); // Initialize the session after a short delay.
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            console.log('Received message from OpenAI:', data); // Log the raw message received from OpenAI.
            try {
                const response = JSON.parse(data); // Parse the message data as JSON.

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response); // Log the event if it is in the list of event types to log.
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media', // Define the media event type.
                        streamSid: streamSid, // Set the stream SID.
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') } // Set the media payload to the audio delta.
                    };
                    connection.send(JSON.stringify(audioDelta)); // Send the audio delta to the connection.

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp; // Set the response start timestamp to the latest media timestamp.
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`); // Log the start timestamp if timing math is enabled.
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id; // Set the last assistant item to the response item ID.
                    }
                    
                    sendMark(connection, streamSid); // Send a mark event to the connection.
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent(); // Handle the speech started event.
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data); // Log an error if there is an issue processing the message.
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message); // Parse the message data as JSON.

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp; // Update the latest media timestamp.
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`); // Log the media message timestamp if timing math is enabled.
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append', // Define the input audio buffer append type.
                                audio: data.media.payload // Set the audio payload.
                            };
                            openAiWs.send(JSON.stringify(audioAppend)); // Send the audio append event to OpenAI.
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid; // Set the stream SID.
                        console.log('Incoming stream has started', streamSid); // Log the start of the incoming stream.

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null; 
                        latestMediaTimestamp = 0;
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift(); // Remove the first item from the mark queue.
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event); // Log non-media events.
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message); // Log an error if there is an issue parsing the message.
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); // Close the OpenAI WebSocket if it is open.
            console.log('Client disconnected.'); // Log when a client disconnects.
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API'); // Log when disconnected from the OpenAI Realtime API.
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error); // Log errors in the OpenAI WebSocket.
        });
    });
});

// Start the Fastify server and listen on the specified port
fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err); // Log any errors that occur when starting the server.
        process.exit(1); // Exit the process with a failure code if there is an error.
    }
    console.log(`Server is listening on port ${PORT}`); // Log that the server is listening on the specified port.
});

// Function to initiate an outbound call using Twilio
const initiateOutboundCall = async(userPhoneNumber, twilioPhoneNumber) => {
    try {
        const call = await twilioClient.calls.create({
            url: 'https://3d62-144-121-171-106.ngrok-free.app/incoming-call', // Set the URL for the call to connect to.
            to: userPhoneNumber, // Set the recipient's phone number.
            from: twilioPhoneNumber // Set the sender's Twilio phone number.
        });
        console.log(`Call initiated with SID: ${call.sid}`); // Log the call SID when the call is initiated.
    } catch (error) {
        console.error('Error initiating call:', error); // Log any errors that occur when initiating the call.
    }
};

// Example usage of the initiateOutboundCall function
const userPhoneNumber = '+19177174489'; // Replace with the user's phone number.
const twilioPhoneNumber = '+13058943349'; // Replace with your Twilio phone number.
initiateOutboundCall(userPhoneNumber, twilioPhoneNumber); // Initiate an outbound call with the specified phone numbers.
