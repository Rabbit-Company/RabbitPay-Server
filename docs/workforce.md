# Timesheets, tickets and payroll

These parts of a project need a workforce license, which covers 5 people. Larger
teams add employee seat keys, see [Administration](administration.md#licensing).
They are built around Slovenian employment rules.

## Roles

Two roles exist for the people who log time:

- `employee` logs their own working hours and absences and works on tickets.
- `supervisor` manages everyone's timesheets, absences and tickets and runs the
  work hour reports.

Owners and administrators can do the same. Managers work with tickets but not
timesheets. Employee records and pay need their own permissions, so a supervisor
sees hours but not salaries.

## Timesheets

Each person logs regular hours, overtime and breaks per day. An end time earlier
than the start time continues into the next day. Breaks up to the configured
length count as working time. Fill working days adds normal hours, with a lunch
break, to every working day in a range that has no time yet. Slovenian public
holidays are known and are not treated as working days.

Every change to time and absences is kept in a change history with who made it
and why, and the employee can read it.

## Absences

Absences are vacation, sick leave, work injury, paid leave, unpaid leave,
parental leave or other, for whole days or part of a day. A request waits until
a supervisor approves or rejects it. Vacation balances per year show the days
the person is entitled to, those used, those approved ahead and those still
waiting.

## Reports

The work hour report sums hours, overtime, holidays and absences per person for
any period and can be downloaded as a PDF. The gross pay estimate works out pay
from those hours with the overtime, night, Sunday, holiday and seniority
supplements set in the timesheet rules, plus meal and commuting allowances. It is
an estimate, not a payslip.

## Tickets

Tickets are tasks, bug reports, feature requests and support requests, assigned
to one or more people and optionally linked to a customer. Time logged on a
ticket appears in the timesheets, and a ticket can have its own hourly rate.
Invoice the logged hours creates a draft invoice for the customer, to check
before issuing it. Several tickets for the same customer can be selected so
small jobs are combined on one invoice, with each ticket kept as its own line.
A ticket can instead have a fixed price, which is billed once regardless of
the time logged on it.

People who work on tickets can attach files to a ticket, either with the Attach
files button or by pasting a screenshot. A file can be up to 25 MB by default.
Owners and administrators raise or lower that for their project under License,
Manage files, up to the maximum the server allows. Files are sent in 16 MB
parts, so large videos do not need a large request. The browser stores PNG and
BMP pictures as lossless WebP when that is smaller. Pictures up to 10 MB get a
preview. The uploader, supervisors, administrators and owners can remove a
file, which deletes it from storage and leaves a note on the ticket saying who
removed it and when. Customers do not see attached files. Files use the
project's file storage, which is separate from document storage (see
[Administration](administration.md)).

## Chat

Chat lets the people in a project write to each other, either one to one or in
named groups. It is open to every role except viewer, developer and cashier
and needs the workforce license. A direct conversation always has the same two
people. A group has a name and up to 100 people, and the person who creates it
is its admin. Group admins rename the group and add or remove people, and
anyone can leave. When the last admin leaves, the person who has been in the
group longest becomes admin, and a group that everyone left is deleted with
its messages.

Messages arrive live over a WebSocket at `/api/v1/realtime`, so the reverse
proxy in front of the server has to pass WebSocket upgrades through on
HTTP/1.1. The browser reconnects by itself after a network outage and loads
what it missed. A message can be up to 4000 characters. Its author can edit or
delete it, and a group admin can delete anyone's message in that group. Message
text is encrypted in the database with the server's master key, and a deleted
message has its text erased. Only the people in a conversation can read it.
Owners and administrators cannot open other people's conversations.

A message can carry up to 10 files, attached with the Attach button or by
pasting. They are stored like ticket attachments, use the project's file
storage and follow its largest file setting. The sender and group admins can
delete an attachment, and the message then shows that it was deleted and by
whom. Owners and administrators see chat attachments under License, Manage
files only as "Chat attachment" with their size, sender and date. They cannot
open them or see their names, but they can delete them to free storage.
Deleting a message deletes its attachments, and files that were attached but
never sent are discarded after a day.

Chat attachments and recordings count toward the project's file storage and
toward the sender's own limit, together with what the person keeps in Files.
A person at their limit cannot attach files or start a recording, and a
running recording stops when the limit is reached. They are not shown among a
person's files. Files has a My chat attachments entry instead, which lists everything
the person sent in chat with its size, conversation and date. There they can
remove single attachments or all of their attachments older than 30 days, 3
months, 6 months or a year, or all of them. Owners and administrators have the
same choice under License, Manage files for the chat attachments of everyone
in the project.

### Calls

In a direct conversation, Call and Video call ring the other person in every
browser tab they have open. The call connects from browser to browser, so
audio, video and a shared screen do not pass through the RabbitPay server and
a running call survives a short outage or restart of the server. During a
call each person can mute, turn the camera on or off and share their screen.
Only one of the two can share a screen at a time. The call stays in a panel
at the corner of the page while the person keeps working, and the
conversation keeps a line for every call with its length, or a note that it
was missed, declined or cancelled. A missed call counts as unread. Calling
someone who is not online records a missed call for them.

Chat shows a presence dot next to each person: Available (green) while they
have RabbitPay open in any tab, In a call (red) from the moment a call rings
until it ends, including group calls, and Offline (an empty ring) otherwise.
Each person can also choose Away (yellow) or Do not disturb (a red ring with a
line) at the top of the conversation list. The choice is stored on the account
(accounts.chat_status, read and set through GET and PUT
/api/v1/realtime/status) and applies in every project and tab. A call to
someone on Do not disturb does not ring: the caller gets error 1332 and a
missed call is recorded. Their browser also skips the pop up for new messages.
In a call wins over the chosen status, and Offline wins over everything.
Apart from that choice presence is not stored. The server derives it from open
realtime connections and running calls and sends a chat.presence event to the colleagues who share
a project chat with the person. A closed or reloaded tab counts as offline
only after 5 seconds, so a page reload does not flicker.

A group conversation has Start call when the server has media servers
configured. Everyone in the group sees that a call is running and joins with
Join call. It does not ring. Group calls go through a LiveKit media server
instead of browser to browser, so each person sends their audio and video only
once however many people take part. One person shares a screen at a time. The
call ends when the last person leaves and the conversation keeps a line with
its length. The call panel has its own Chat for quick messages that everyone
in the call sees, guests included. Those messages are not saved.

Schedule meeting, in the New menu of Chat, creates a group with a title, a
start time and a length, and invites the chosen people. The meeting is an
ordinary group, so its conversation, files and call work the same way, and
the time is only shown, nothing starts by itself. A meeting can allow guests.
Group details then shows a guest link that anyone can open without an
account. A guest enters a name and can join only while a call started by a
member is running, and when the last member leaves, the call ends for the
guests too. Guests are marked as guests in the call, do not count as employee
seats and see nothing of the project except the meeting title, the company
name and the time. A group admin can replace the link, which makes the old
one stop working, or turn guest access off.

Record, in any call, records in the browser of the member who pressed it:
the voices of everyone in the call mixed together and the shared screen, or a
title card while nobody shares. Everyone in the call, guests included, sees
who is recording, and only one person records at a time. The recording is
uploaded in 16 MB parts while the call runs and is added to the conversation
as a WebM video when recording stops, where it is stored encrypted like every
other chat attachment and uses the project's file storage. If the browser of
the person recording closes, the parts already uploaded are kept and the
recording appears in the conversation a few minutes later, without the last
minute or two. A call between two people is recorded the same way: both
voices and the shared screen, added to their direct conversation, and the
other person sees that the call is being recorded.

Screen sharing has its own quality, in group calls and in calls between two
people. The arrow next to the
share button offers High (1080p, 30 frames, 4000 kbps), Medium (1080p, 15
frames, 2500 kbps) and Low (720p, 15 frames, 1500 kbps), remembered in the
browser. Under Admin, Settings, Calls the administrator sets the highest
resolution (1080), frame rate (30) and bitrate (5000 kbps) for shared screens,
and choices above a limit are lowered to it.

The camera has its own quality too, in both kinds of call. The arrow next to
the camera button offers High (1080p, 30 frames, 3000 kbps), Medium (720p, 30
frames, 1700 kbps) and Low (360p, 20 frames, 500 kbps), remembered in the
browser and applied at once when the camera is already on. Medium is the
default. Under Admin, Settings, Calls the administrator sets the highest
camera resolution (1080), frame rate (30) and bitrate (3000 kbps), and choices
above a limit are lowered to it. In a group call the media server still sends
smaller copies of each camera to people who see it in a small tile.

Each person chooses the quality of the recordings they make under Files, My
chat attachments, because a recording counts toward their own storage: High
(1080p, 30 frames, 3000 kbps, about 1.4 GB per hour), Medium (1080p, 15
frames, 2000 kbps), Low (720p, 15 frames, 1500 kbps) or Custom, where they
set the resolution, frame rate and video bitrate themselves. The choice is
kept in their browser, and the arrow next to the record button in a call
overrides it for that call. Under Admin, Settings, Calls the administrator sets
the highest values anyone can use: the picture height (1080 by default, up to
2160 for 4K), the frame rate (60) and the video bitrate (5000 kbps), plus the
audio bitrate (64 kbps) used by every recording. Presets above a limit are
lowered to it.

The server only passes the connection details between the two browsers. Under
Admin, Settings, Calls the administrator sets the STUN servers that let
browsers find each other and, optionally, TURN servers that relay a call when
a firewall blocks the direct connection. TURN uses the shared secret of a
coturn server (`use-auth-secret`), from which every call gets its own
credentials that expire after six hours. Without TURN, a small share of calls
between strict networks cannot connect. Browsers only allow the microphone,
camera and screen sharing on HTTPS or on localhost.

Group calls need one or more [LiveKit](https://github.com/livekit/livekit)
servers, hosted apart from RabbitPay so that calls never use its bandwidth or
processor. Enter their WebSocket addresses under Admin, Settings, Calls
together with the API key and secret, which must be the same on every media
server. A new call is placed on the reachable server with the fewest people
on it and stays there. RabbitPay hands each person a token that is valid for
that one room, and it asks the media server every minute who is still
connected, so a call whose participants all lost their connection is closed.
If a media server fails, only its calls drop and people can start the call
again on another server. Without media servers, groups have no call button,
meetings cannot be scheduled and calls between two people keep working.

## Files

Files is a file manager for the team, open to every role except viewer,
developer and cashier. People create folders, upload files of any type and
move or rename them. A person's own files and folders are visible only to them
until they share them. Any folder and any single file, at any depth, can be
shared with everyone in the project or with chosen people. Sharing a folder
covers everything inside it, and whoever can open a folder can add to it.
Sharing only adds people: someone who was given one subfolder or one file sees
that item without the folder around it. Everything other people shared with a
person is in the built-in Shared with me folder, grouped by the person the
items belong to, so the top of Files holds only a person's own things. Owners
and administrators also get Everyone's files, which lists what every other
person keeps in Files, grouped the same way. The person
who added an item and whoever made a folder above it can share, rename, move
and delete it. Owners and administrators can open everything.

Files and ticket attachments share the project's file storage. Owners and
administrators can also limit how much each person keeps in Files and sends
as chat attachments and recordings, with one limit for everyone and a separate
limit for individual people. Ticket attachments do not count toward a person's
limit.

A customer can see tickets in the [customer portal](customer-portal.md) only
after a project member gives them access and marks the tickets they may see. The
project also chooses which kinds of ticket customers may open themselves.

## Employee records

Employee records hold the job title, employment type, pay, start date, prior
service (for the seniority supplement) and the personal details payroll needs.
They are encrypted on the server and only people allowed to see employee records
can read them. Deleting a record keeps the timesheets and absences.

## Payroll

A payroll run takes a month's timesheets, absences and employee records and works
out gross and net pay for everyone with an employee record. Bonuses, taxable
additions, tax-free refunds and deductions can be added per person, and a run
can be recalculated until it is finalized. The tax and contribution rates are
kept as tables that start from a given month, so a change in the law is a new
table rather than an edit to history.

From a finalized run RabbitPay produces:

- a payslip PDF for each employee,
- the REK-O XML for eDavki, one per kind of payment (salary, holiday allowance or
  performance pay), to import and sign there,
- a SEPA credit transfer file (pain.001) with one salary payment per employee,
  to upload in your online bank.

Not handled yet: severance pay, non-residents, student work and contractors, and
REK-O corrections. Check the results with your accountant before paying.
