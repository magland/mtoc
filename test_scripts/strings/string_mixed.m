% Mixed numeric and string data: types must be tracked correctly
% across control flow.
x = 3;
label = "value:";

if x > 0
    msg = "positive";
else
    msg = "non-positive";
end

disp(label);
disp(msg);
disp(x);
disp(x * x);

% Reassign within the same string variable
msg = msg + "!";
disp(msg);

for k = 1:3
    disp(label);
end
