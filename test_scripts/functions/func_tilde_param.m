% Ignored function parameters declared with `~` are positional
% placeholders — the body can't reference them, but the function still
% has the slot in its signature. Cover scalar and tensor cases, plus
% multiple `~` params in one definition.

a = first_only(42);
disp(a);

b = second_only(10, 99);
disp(b);

c = all_ignored(1, 2, 3);
disp(c);

d = tensor_arg([1, 2, 3, 4]);
disp(d);

function r = first_only(~)
    r = 7;
end

function r = second_only(x, ~)
    r = x + 1;
end

function r = all_ignored(~, ~, ~)
    r = 100;
end

function r = tensor_arg(~)
    r = -1;
end
