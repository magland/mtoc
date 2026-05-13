% Empty homogeneous cell grown via a variable-index write inside a
% loop. numbl auto-grows on every curly-brace write (literal or
% variable index); mtoc emits a `_grow` call before the slot store
% so the buffer length tracks the largest index written so far.
c = {};
for j = 1:3
    c{j} = j * 10;
end
disp(c{1});
disp(c{2});
disp(c{3});
